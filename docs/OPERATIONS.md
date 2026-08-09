# Running the business side

Everything a school can do to itself is self-service. Everything that costs
money is deliberately not — seats, term and licence status are set by you, so a
school cannot licence itself for free by editing a request in dev tools. There
is no `UPDATE` policy on `schools` at all; admins go through
`update_school_profile()`, which only touches name, domains and billing fields.

There is **no payment processing**. Quotes arrive in the database, you invoice
against a PO, and you activate the licence with the SQL below. That matches how
districts actually buy, but it does mean activation is a manual step.

## Reading new quote requests

Nobody can read `quote_requests` through the API — not even a signed-in school
admin. They are readable only with the database password, from the Supabase SQL
editor:

```sql
select created_at, school_name, contact_name, contact_email, contact_phone,
       students, campuses, term_years, price_per_seat, contract_total, notes
from quote_requests
where status = 'new'
order by created_at desc;
```

Mark one as handled:

```sql
update quote_requests set status = 'quoted' where id = '<uuid>';
```

## Activating a school once they've paid

Find the school, then set what they bought. `price_per_seat` should match the
tier on their quote — the calculator's tiers live in
[`web/pricing.js`](../web/pricing.js).

```sql
update schools
   set status          = 'active',
       seats_purchased = 1200,
       price_per_seat  = 7.00,
       term_start      = date '2026-09-01',
       term_end        = date '2027-08-31'
 where slug = 'riverside-high-school';
```

The admin console picks that up on their next page load: the trial chip becomes
"active", the seat meter re-scales, and billing shows the new term.

## Topping up mid-year

```sql
update schools set seats_purchased = seats_purchased + 300
 where slug = 'riverside-high-school';
```

Nothing breaks if a school goes over its seats. That is on purpose — locking a
class out mid-exam because the district under-forecast by nine students would be
indefensible. The console shows the overage in red and prompts them to true it
up; you reconcile at renewal.

## What "seats used" counts

Distinct student names who joined at least one test since `term_start`:

```sql
select public.seats_used('<school-uuid>');
```

One student who sits nine exams is one seat. It is name-based, so a student who
types their name differently twice counts twice — worth knowing before you argue
about an invoice. Tightening that (per-roster identity rather than free text)
would need students to be enrolled up front, which is exactly the friction the
product avoids.

## Expiry is not enforced

A licence going `expired` changes what the console displays. It does **not**
stop teachers running tests. Enforcing it means deciding what happens to a class
mid-exam on renewal day, and the safe answer is "nothing" — so today it is a
reporting state, not a gate. If you want a hard stop, put it at test *creation*,
never at lock time.

## Useful queries

```sql
-- Every school and how much they're worth
select s.name, s.status, s.seats_purchased, public.seats_used(s.id) as used,
       s.price_per_seat, s.price_per_seat * public.seats_used(s.id) as annual_value,
       s.term_end
from schools s order by annual_value desc nulls last;

-- Trials running out this week
select name, term_end, (term_end - current_date) as days_left
from schools where status = 'trial' and term_end between current_date and current_date + 7;

-- Schools over their seat count
select s.name, s.seats_purchased, public.seats_used(s.id) as used
from schools s where public.seats_used(s.id) > s.seats_purchased;
```
