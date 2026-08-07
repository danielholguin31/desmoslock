-- DesmosLock — Supabase schema
--
-- Run this in the Supabase SQL editor (or `supabase db push`) on a fresh project.
-- It is idempotent enough to re-run during development.
--
-- Identity model:
--   Teachers  -> real Supabase auth users (email + password).
--   Students  -> anonymous auth users. Enable Anonymous Sign-ins under
--                Authentication > Providers before using this.
--
-- The rule that shapes every policy below: a student must never be able to read
-- the override code, another student's row, or any test they have not joined.

create extension if not exists "pgcrypto";

/* ─────────────────────────────────────────────────────────── tables */

-- Teacher profile, 1:1 with auth.users.
create table if not exists public.teachers (
  id          uuid primary key references auth.users on delete cascade,
  email       text        not null,
  name        text        not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists public.tests (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid        not null references public.teachers(id) on delete cascade,
  title       text        not null default 'Untitled test',
  join_code   text        not null,
  locked      boolean     not null default false,
  active      boolean     not null default true,
  created_at  timestamptz not null default now(),
  locked_at   timestamptz,
  ended_at    timestamptz
);

-- Only one live test may hold a given join code.
create unique index if not exists tests_active_join_code_idx
  on public.tests (join_code) where active;

create index if not exists tests_teacher_idx on public.tests (teacher_id, created_at desc);

-- Override code lives apart from `tests` so no student-readable policy can ever
-- leak it: nothing but the owning teacher and the security-definer RPCs read it.
create table if not exists public.test_secrets (
  test_id       uuid primary key references public.tests(id) on delete cascade,
  override_code text not null
);

create table if not exists public.students (
  id          uuid primary key default gen_random_uuid(),
  test_id     uuid        not null references public.tests(id) on delete cascade,
  user_id     uuid        not null references auth.users on delete cascade,
  name        text        not null,
  flags       integer     not null default 0,
  released    boolean     not null default false,
  removed     boolean     not null default false,
  forfeited   boolean     not null default false,
  joined_at   timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  exited_at   timestamptz
);

create unique index if not exists students_test_user_idx on public.students (test_id, user_id);
create index if not exists students_test_idx on public.students (test_id);

create table if not exists public.alerts (
  id           uuid primary key default gen_random_uuid(),
  test_id      uuid        not null references public.tests(id) on delete cascade,
  student_id   uuid        not null references public.students(id) on delete cascade,
  student_name text        not null,
  kind         text        not null,
  detail       text        not null default '',
  severe       boolean     not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists alerts_test_idx on public.alerts (test_id, created_at desc);

-- A teacher profile appears the moment a real (non-anonymous) user signs up.
-- Students are anonymous users and deliberately get no teachers row.
create or replace function public.handle_new_user ()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.is_anonymous, false) = false and new.email is not null then
    insert into public.teachers (id, email, name)
    values (
      new.id,
      new.email,
      coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1))
    )
    on conflict (id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

/* ────────────────────────────────────────────────────────── helpers */

-- Is the caller the teacher who owns this test?
create or replace function public.owns_test (p_test uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tests t where t.id = p_test and t.teacher_id = auth.uid());
$$;

-- Is the caller a student currently in this test?
create or replace function public.is_in_test (p_test uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from students s
    where s.test_id = p_test and s.user_id = auth.uid() and not s.removed
  );
$$;

/* ───────────────────────────────────────────────────── row security */

alter table public.teachers     enable row level security;
alter table public.tests        enable row level security;
alter table public.test_secrets enable row level security;
alter table public.students     enable row level security;
alter table public.alerts       enable row level security;

-- teachers: your own profile, nothing else.
drop policy if exists teachers_self on public.teachers;
create policy teachers_self on public.teachers
  for all using (id = auth.uid()) with check (id = auth.uid());

-- tests: the owning teacher does anything; a joined student may only read.
drop policy if exists tests_owner on public.tests;
create policy tests_owner on public.tests
  for all using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

drop policy if exists tests_student_read on public.tests;
create policy tests_student_read on public.tests
  for select using (public.is_in_test(id));

-- test_secrets: teacher only. Students reach the override through an RPC.
drop policy if exists secrets_owner on public.test_secrets;
create policy secrets_owner on public.test_secrets
  for all using (public.owns_test(test_id)) with check (public.owns_test(test_id));

-- students: teacher sees the whole roster; a student sees only their own row.
drop policy if exists students_teacher on public.students;
create policy students_teacher on public.students
  for all using (public.owns_test(test_id)) with check (public.owns_test(test_id));

drop policy if exists students_self_read on public.students;
create policy students_self_read on public.students
  for select using (user_id = auth.uid());

-- Students may touch their own heartbeat and nothing else. The column guard
-- lives in the heartbeat RPC; this policy just scopes the row.
drop policy if exists students_self_update on public.students;
create policy students_self_update on public.students
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- alerts: teacher reads their tests' alerts; students may only file their own.
drop policy if exists alerts_teacher_read on public.alerts;
create policy alerts_teacher_read on public.alerts
  for select using (public.owns_test(test_id));

drop policy if exists alerts_student_insert on public.alerts;
create policy alerts_student_insert on public.alerts
  for insert with check (
    exists (
      select 1 from students s
      where s.id = student_id and s.user_id = auth.uid() and s.test_id = alerts.test_id
    )
  );

/* ────────────────────────────────────────────── alert bookkeeping */

-- Severity and the per-student flag counter are decided in the database, so a
-- patched client cannot file a "harmless" version of a serious event.
create or replace function public.on_alert_insert ()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.severe := new.kind in (
    'left_app', 'quit_attempt', 'screen_locked', 'override_used', 'override_failed',
    'display_changed', 'forced_exit', 'forfeited'
  );
  if new.severe then
    update students set flags = flags + 1 where id = new.student_id;
  end if;
  return new;
end;
$$;

drop trigger if exists alerts_before_insert on public.alerts;
create trigger alerts_before_insert
  before insert on public.alerts
  for each row execute function public.on_alert_insert();

/* ──────────────────────────────────────────────────────────── RPCs */

-- Codes with no O/0, I/1 or S/5 to read aloud in a noisy room.
create or replace function public.generate_code (len int default 6)
returns text language plpgsql volatile as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRTUVWXYZ234679';
  out text := '';
begin
  for _ in 1..len loop
    out := out || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return out;
end;
$$;

-- Teacher: start a test. Returns the row plus the override code, once.
create or replace function public.create_test (p_title text)
returns table (id uuid, join_code text, override_code text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_test  uuid;
  v_join  text;
  v_over  text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;

  loop
    v_join := generate_code(6);
    exit when not exists (select 1 from tests t where t.active and t.join_code = v_join);
  end loop;
  v_over := generate_code(6);

  insert into tests (teacher_id, title, join_code)
  values (auth.uid(), coalesce(nullif(trim(p_title), ''), 'Untitled test'), v_join)
  returning tests.id into v_test;

  insert into test_secrets (test_id, override_code) values (v_test, v_over);

  return query select v_test, v_join, v_over;
end;
$$;

-- Student: join by code. Security definer, because a student has no read access
-- to `tests` until this has put them in one.
create or replace function public.join_test (p_code text, p_name text)
returns table (test_id uuid, student_id uuid, title text, locked boolean)
language plpgsql security definer set search_path = public as $$
-- The OUT names (test_id, student_id, title, locked) are also column names.
-- Without this, ON CONFLICT (test_id, user_id) below is ambiguous — 42702.
#variable_conflict use_column
declare
  v_test tests%rowtype;
  v_student uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if length(trim(p_name)) < 2 then raise exception 'enter your full name'; end if;

  select * into v_test from tests t
   where t.join_code = upper(trim(p_code)) and t.active
   limit 1;
  if not found then raise exception 'that code is not active'; end if;

  insert into students (test_id, user_id, name)
  values (v_test.id, auth.uid(), trim(p_name))
  on conflict (test_id, user_id) do update
    set name = excluded.name, released = false, removed = false, last_seen = now()
  returning students.id into v_student;

  insert into alerts (test_id, student_id, student_name, kind)
  values (v_test.id, v_student, trim(p_name), 'joined');

  return query select v_test.id, v_student, v_test.title, v_test.locked;
end;
$$;

-- Teacher: lock / unlock / end. A fresh lock clears previous releases.
create or replace function public.set_lock (p_test uuid, p_locked boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not owns_test(p_test) then raise exception 'not your test'; end if;
  update tests set locked = p_locked, locked_at = case when p_locked then now() else locked_at end
   where id = p_test;
  if p_locked then
    update students set released = false where test_id = p_test;
  end if;
end;
$$;

create or replace function public.end_test (p_test uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not owns_test(p_test) then raise exception 'not your test'; end if;
  update tests set locked = false, active = false, ended_at = now() where id = p_test;
end;
$$;

-- Student: the ✕ Exit button. Leaving a live lock forfeits the test.
create or replace function public.forfeit_test (p_reason text default '')
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_student students%rowtype;
  v_locked  boolean;
begin
  select * into v_student from students where user_id = auth.uid() and not removed
   order by joined_at desc limit 1;
  if not found then raise exception 'not in a test'; end if;

  select (t.locked and not v_student.released) into v_locked from tests t where t.id = v_student.test_id;

  update students
     set released = true, exited_at = now(), forfeited = coalesce(v_locked, false)
   where id = v_student.id;

  insert into alerts (test_id, student_id, student_name, kind, detail)
  values (v_student.test_id, v_student.id, v_student.name,
          case when v_locked then 'forfeited' else 'left_session' end, coalesce(p_reason, ''));

  return coalesce(v_locked, false);
end;
$$;

-- Student: emergency override. The code is compared inside the database, so it
-- is never sent to a student client. Both outcomes are logged.
create or replace function public.use_override (p_code text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_student students%rowtype;
  v_ok boolean;
begin
  select * into v_student from students where user_id = auth.uid() and not removed
   order by joined_at desc limit 1;
  if not found then raise exception 'not in a test'; end if;

  select (s.override_code = upper(trim(p_code))) into v_ok
    from test_secrets s where s.test_id = v_student.test_id;

  if coalesce(v_ok, false) then
    update students set released = true where id = v_student.id;
    insert into alerts (test_id, student_id, student_name, kind)
    values (v_student.test_id, v_student.id, v_student.name, 'override_used');
    return true;
  end if;

  insert into alerts (test_id, student_id, student_name, kind, detail)
  values (v_student.test_id, v_student.id, v_student.name, 'override_failed',
          left(coalesce(p_code, ''), 12));
  return false;
end;
$$;

create or replace function public.heartbeat ()
returns void language plpgsql security definer set search_path = public as $$
begin
  update students set last_seen = now() where user_id = auth.uid() and not removed;
end;
$$;

/* ─────────────────────────────────────────────────────── realtime */

-- The desktop app subscribes to these three tables instead of running a
-- WebSocket server. RLS applies to realtime, so a student only ever receives
-- rows they are allowed to read.
do $$
declare t text;
begin
  foreach t in array array['tests', 'students', 'alerts'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Realtime needs the full row on update to diff lock state reliably.
alter table public.tests    replica identity full;
alter table public.students replica identity full;
