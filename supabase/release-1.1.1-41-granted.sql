-- Release 1.1.1 #41 (audit M3, October 2026): permanent record of granted checkouts.
-- Run on mojialand-staging first, then on mojialand-live only after Danny's OK.
-- Safe to run twice. Checkout ID and time only: no email, no code. Nightly
-- cleanup never deletes these rows, so an old checkout never grants again.
create table if not exists public.granted_checkouts (
  session_id text primary key,
  granted_at timestamptz not null default now()
);
alter table public.granted_checkouts enable row level security;
revoke all on public.granted_checkouts from public, anon, authenticated;
grant select, insert on public.granted_checkouts to service_role;
-- Every checkout granted so far: first passes, then add and upgrade checkouts.
insert into public.granted_checkouts (session_id, granted_at)
  select stripe_session_id, created_at from public.passes where stripe_session_id is not null
  on conflict do nothing;
insert into public.granted_checkouts (session_id, granted_at)
  select session_id, processed_at from public.stripe_events
   where event_id like 'grant:%' and session_id is not null
  on conflict do nothing;
