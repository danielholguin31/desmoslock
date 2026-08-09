-- DesmosLock — schools, seats, roles, invites, quotes
--
-- Run AFTER schema.sql. Idempotent; safe to re-run.
--
-- Licensing model: schools buy seats, one seat per student per year. Teachers
-- never pay and never see billing. A teacher belongs to exactly one school at a
-- time, either by accepting an invite or by signing up with an email on the
-- school's verified domain.

/* ─────────────────────────────────────────────────────────── tables */

do $$ begin
  create type public.member_role as enum ('owner', 'admin', 'teacher');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.license_status as enum ('trial', 'active', 'expired', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.schools (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  slug             text not null unique,
  -- Email domains that auto-join as teachers, e.g. {"riverside.k12.us"}.
  allowed_domains  text[] not null default '{}',
  seats_purchased  integer not null default 50,
  price_per_seat   numeric(6,2) not null default 8.00,
  status           public.license_status not null default 'trial',
  term_start       date not null default current_date,
  term_end         date not null default (current_date + 30),
  billing_email    text,
  billing_contact  text,
  purchase_order   text,
  created_at       timestamptz not null default now()
);

create table if not exists public.memberships (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools(id) on delete cascade,
  user_id     uuid not null references auth.users on delete cascade,
  role        public.member_role not null default 'teacher',
  created_at  timestamptz not null default now(),
  unique (user_id)                    -- one school per teacher, for now
);

create index if not exists memberships_school_idx on public.memberships (school_id);

create table if not exists public.invites (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools(id) on delete cascade,
  email       text not null,
  role        public.member_role not null default 'teacher',
  invited_by  uuid references auth.users on delete set null,
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  unique (school_id, email)
);

create index if not exists invites_email_idx on public.invites (lower(email)) where accepted_at is null;

-- Quote requests from the website. Anyone may file one; only the row's own
-- contact details go in, and nobody but us can read them back.
create table if not exists public.quote_requests (
  id             uuid primary key default gen_random_uuid(),
  school_name    text not null,
  contact_name   text not null,
  contact_email  text not null,
  contact_phone  text,
  job_title      text,
  country        text,
  region         text,
  students       integer not null,
  campuses       integer not null default 1,
  term_years     integer not null default 1,
  start_date     date,
  price_per_seat numeric(6,2),
  annual_total   numeric(12,2),
  contract_total numeric(12,2),
  hear_about     text,
  notes          text,
  status         text not null default 'new',
  created_at     timestamptz not null default now()
);

-- Tests belong to a school so seats can be counted and a whole district can be
-- audited. Nullable: a teacher with no school yet is on a personal trial.
alter table public.tests add column if not exists school_id uuid references public.schools(id) on delete set null;
create index if not exists tests_school_idx on public.tests (school_id, created_at desc);

/* ────────────────────────────────────────────────────────── helpers */

create or replace function public.my_school ()
returns uuid language sql stable security definer set search_path = public as $$
  select school_id from memberships where user_id = auth.uid() limit 1;
$$;

create or replace function public.my_role ()
returns public.member_role language sql stable security definer set search_path = public as $$
  select role from memberships where user_id = auth.uid() limit 1;
$$;

create or replace function public.is_school_admin ()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships
    where user_id = auth.uid() and role in ('owner', 'admin')
  );
$$;

-- Seats in use: distinct students who sat a test in the current licence term.
-- Billing is per student per year, so this is the number that matters.
create or replace function public.seats_used (p_school uuid)
returns integer language sql stable security definer set search_path = public as $$
  select count(distinct lower(st.name))::int
  from students st
  join tests t on t.id = st.test_id
  join schools sc on sc.id = t.school_id
  where t.school_id = p_school
    and st.removed = false
    and t.created_at >= sc.term_start;
$$;

/* ────────────────────────────────────────────── membership plumbing */

-- Slugify a school name into something unique and URL-safe.
create or replace function public.school_slug (p_name text)
returns text language plpgsql volatile set search_path = public as $$
declare base text; candidate text; n int := 0;
begin
  base := regexp_replace(lower(trim(coalesce(p_name, 'school'))), '[^a-z0-9]+', '-', 'g');
  base := trim(both '-' from base);
  if base = '' then base := 'school'; end if;
  candidate := base;
  while exists (select 1 from schools s where s.slug = candidate) loop
    n := n + 1;
    candidate := base || '-' || n;
  end loop;
  return candidate;
end;
$$;

-- A teacher signing up either lands in a school that invited them, or in one
-- whose verified domain matches their email. Everyone else stays unaffiliated
-- until an admin invites them.
create or replace function public.claim_membership ()
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_invite invites%rowtype;
  v_school uuid;
begin
  if auth.uid() is null then return null; end if;
  select school_id into v_school from memberships where user_id = auth.uid() limit 1;
  if v_school is not null then return v_school; end if;

  select email into v_email from auth.users where id = auth.uid();
  if v_email is null then return null; end if;

  select * into v_invite from invites
   where lower(email) = lower(v_email) and accepted_at is null
   order by created_at limit 1;

  if found then
    insert into memberships (school_id, user_id, role)
    values (v_invite.school_id, auth.uid(), v_invite.role)
    on conflict (user_id) do nothing;
    update invites set accepted_at = now() where id = v_invite.id;
    return v_invite.school_id;
  end if;

  select id into v_school from schools
   where lower(split_part(v_email, '@', 2)) = any (
     select lower(d) from unnest(allowed_domains) d
   )
   limit 1;

  if v_school is not null then
    insert into memberships (school_id, user_id, role)
    values (v_school, auth.uid(), 'teacher')
    on conflict (user_id) do nothing;
  end if;

  return v_school;
end;
$$;

-- Create a school and become its owner. Starts a 30-day, 50-seat trial.
create or replace function public.create_school (p_name text, p_domain text default null)
returns uuid language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_school uuid; v_domains text[] := '{}';
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from memberships where user_id = auth.uid()) then
    raise exception 'you already belong to a school';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'enter the school name'; end if;

  if p_domain is not null and trim(p_domain) <> '' then
    v_domains := array[lower(trim(replace(p_domain, '@', '')))];
    -- Two schools sharing a domain would make auto-join ambiguous, and would
    -- silently drop a teacher into somebody else's district.
    if exists (select 1 from schools s where v_domains[1] = any (
                 select lower(d) from unnest(s.allowed_domains) d)) then
      raise exception 'that email domain is already claimed by another school';
    end if;
  end if;

  insert into schools (name, slug, allowed_domains)
  values (trim(p_name), school_slug(p_name), v_domains)
  returning id into v_school;

  insert into memberships (school_id, user_id, role) values (v_school, auth.uid(), 'owner');
  return v_school;
end;
$$;

create or replace function public.invite_member (p_email text, p_role public.member_role default 'teacher')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_school uuid; v_id uuid;
begin
  if not is_school_admin() then raise exception 'admins only'; end if;
  v_school := my_school();
  if p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'enter a valid email address'; end if;
  if p_role = 'owner' then raise exception 'there can only be one owner'; end if;

  insert into invites (school_id, email, role, invited_by)
  values (v_school, lower(trim(p_email)), p_role, auth.uid())
  on conflict (school_id, email) do update set role = excluded.role, accepted_at = null
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.set_member_role (p_user uuid, p_role public.member_role)
returns void language plpgsql security definer set search_path = public as $$
declare v_school uuid;
begin
  if not is_school_admin() then raise exception 'admins only'; end if;
  v_school := my_school();
  if p_user = auth.uid() then raise exception 'you cannot change your own role'; end if;
  if p_role = 'owner' then raise exception 'ownership transfer is not supported here'; end if;
  if exists (select 1 from memberships where user_id = p_user and school_id = v_school and role = 'owner') then
    raise exception 'the owner''s role cannot be changed';
  end if;
  update memberships set role = p_role where user_id = p_user and school_id = v_school;
end;
$$;

create or replace function public.remove_member (p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_school uuid;
begin
  if not is_school_admin() then raise exception 'admins only'; end if;
  v_school := my_school();
  if p_user = auth.uid() then raise exception 'you cannot remove yourself'; end if;
  if exists (select 1 from memberships where user_id = p_user and school_id = v_school and role = 'owner') then
    raise exception 'the owner cannot be removed';
  end if;
  delete from memberships where user_id = p_user and school_id = v_school;
end;
$$;

-- Stamp new tests with the teacher's school.
create or replace function public.tag_test_school ()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.school_id is null then
    select school_id into new.school_id from memberships where user_id = new.teacher_id limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists tests_tag_school on public.tests;
create trigger tests_tag_school before insert on public.tests
  for each row execute function public.tag_test_school();

/* ───────────────────────────────────────────────────── row security */

alter table public.schools        enable row level security;
alter table public.memberships    enable row level security;
alter table public.invites        enable row level security;
alter table public.quote_requests enable row level security;

drop policy if exists schools_read on public.schools;
create policy schools_read on public.schools
  for select using (id = public.my_school());

-- Deliberately no UPDATE policy. A direct PATCH would let an admin set their
-- own seats_purchased, status and term_end — i.e. licence themselves for free.
-- Admins edit the school through update_school_profile(), which only touches
-- name, domains and billing details.
drop policy if exists schools_admin_write on public.schools;

drop policy if exists memberships_read on public.memberships;
create policy memberships_read on public.memberships
  for select using (school_id = public.my_school());

drop policy if exists invites_read on public.invites;
create policy invites_read on public.invites
  for select using (school_id = public.my_school() and public.is_school_admin());

drop policy if exists invites_admin_delete on public.invites;
create policy invites_admin_delete on public.invites
  for delete using (school_id = public.my_school() and public.is_school_admin());

-- Anyone may ask for a quote. Nobody may read them back through the API —
-- they are for us, in the dashboard.
drop policy if exists quotes_public_insert on public.quote_requests;
create policy quotes_public_insert on public.quote_requests
  for insert with check (true);

-- A school's admins may see the whole roster's tests, not just their own.
drop policy if exists tests_school_admin_read on public.tests;
create policy tests_school_admin_read on public.tests
  for select using (school_id is not null and school_id = public.my_school() and public.is_school_admin());

/* ─────────────────────────────────────────────── admin-facing views */

-- Emails live in auth.users, which the `authenticated` role cannot read — and
-- should not be able to. So this view runs as its owner and is gated by an
-- explicit my_school() filter instead: each caller sees their own school's
-- roster and nothing else. Dropping that WHERE clause would expose every
-- school's members to every user, so it is the whole security boundary here.
drop view if exists public.school_members;
create view public.school_members as
  select
    m.user_id,
    m.school_id,
    m.role,
    m.created_at,
    u.email,
    coalesce(nullif(t.name, ''), split_part(u.email, '@', 1)) as name,
    u.last_sign_in_at,
    (select count(*) from tests te where te.teacher_id = m.user_id) as tests_created
  from memberships m
  join auth.users u on u.id = m.user_id
  left join teachers t on t.id = m.user_id
  where m.school_id = public.my_school();

grant select on public.school_members to authenticated;

-- Licence summary for the admin console.
create or replace function public.school_overview ()
returns table (
  id uuid, name text, slug text, status public.license_status,
  seats_purchased integer, seats_used integer, price_per_seat numeric,
  term_start date, term_end date, days_left integer,
  allowed_domains text[], billing_email text, billing_contact text,
  purchase_order text, members integer, pending_invites integer, tests integer,
  my_role public.member_role
)
language sql stable security definer set search_path = public as $$
  select
    s.id, s.name, s.slug, s.status,
    s.seats_purchased, public.seats_used(s.id), s.price_per_seat,
    s.term_start, s.term_end, (s.term_end - current_date)::int,
    s.allowed_domains, s.billing_email, s.billing_contact, s.purchase_order,
    (select count(*)::int from memberships m where m.school_id = s.id),
    (select count(*)::int from invites i where i.school_id = s.id and i.accepted_at is null),
    (select count(*)::int from tests t where t.school_id = s.id),
    public.my_role()
  from schools s
  where s.id = public.my_school();
$$;

-- Admins update billing details; seats and status are ours to set, not theirs.
create or replace function public.update_school_profile (
  p_name text, p_domains text[], p_billing_email text,
  p_billing_contact text, p_purchase_order text
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_school_admin() then raise exception 'admins only'; end if;
  if p_domains is not null and exists (
       select 1 from schools s
       where s.id <> my_school()
         and exists (select 1 from unnest(p_domains) nd
                     join unnest(s.allowed_domains) od on lower(nd) = lower(od))
     ) then
    raise exception 'one of those domains is already claimed by another school';
  end if;

  update schools set
    name            = coalesce(nullif(trim(p_name), ''), name),
    allowed_domains = coalesce(p_domains, allowed_domains),
    billing_email   = nullif(trim(coalesce(p_billing_email, '')), ''),
    billing_contact = nullif(trim(coalesce(p_billing_contact, '')), ''),
    purchase_order  = nullif(trim(coalesce(p_purchase_order, '')), '')
  where id = my_school();
end;
$$;

/* ─────────────────────────────────────────────────────── realtime */

do $$
declare t text;
begin
  foreach t in array array['schools', 'memberships', 'invites'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
