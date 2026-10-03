-- Release 1.1.1 #39 (audit M1, October 2026): Home Screen pairing number.
-- Run on mojialand-staging first, then on mojialand-live only after Danny's OK.
-- Safe to run twice.
--
-- Safari parks the signed pass token for 30 minutes with a 4-digit pairing
-- number. The number is stored only as a hash, and no pass code is stored.
-- The Home Screen app on the same phone types the number. Every wrong number
-- uses one of 3 tries on every waiting pairing with the same phone traits,
-- then those pairings are gone. The old handoffs table is no longer written;
-- its rows (which held plain codes) are deleted here and by nightly cleanup.
create table if not exists public.pairings (
  id         uuid primary key default gen_random_uuid(),
  key_hash   text not null,
  pin_hash   text not null,
  token      text not null,
  tries      integer not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists pairings_key_idx on public.pairings (key_hash);
alter table public.pairings enable row level security;
revoke all on public.pairings from public, anon, authenticated;
grant select, insert, update, delete on public.pairings to service_role;

-- Returns 'none', 'bad:N' (N tries left), or the parked token.
create or replace function public.pair_claim(p_key text, p_pin_hash text) returns text
language plpgsql security definer set search_path = public as $$
declare t text; left_n int;
begin
  perform pg_advisory_xact_lock(hashtext('mojia_pair:' || p_key));
  delete from pairings where expires_at < now() or tries >= 3;
  if not exists (select 1 from pairings where key_hash = p_key) then return 'none'; end if;
  delete from pairings where key_hash = p_key and pin_hash = p_pin_hash returning token into t;
  if t is not null then return t; end if;
  update pairings set tries = tries + 1 where key_hash = p_key;
  select coalesce(min(3 - tries), 0) into left_n from pairings where key_hash = p_key;
  delete from pairings where key_hash = p_key and tries >= 3;
  return 'bad:' || greatest(left_n, 0);
end $$;
revoke all on function public.pair_claim(text, text) from public, anon, authenticated;
grant execute on function public.pair_claim(text, text) to service_role;

delete from public.handoffs;

-- Nightly cleanup: the current function plus the pairings line.
create or replace function public.nightly_cleanup() returns void
language plpgsql security definer set search_path = public as $$
declare
  keep_days integer := coalesce((select (value)::text::integer from settings
                                 where key = 'delete_ended_after_days'), 30);
begin
  update passes set status = 'ended'
   where status = 'active' and ends_at is not null and ends_at < now();

  delete from passes
   where kind = '48h'
     and status in ('ended','refunded')
     and coalesce(ends_at, created_at) < now() - make_interval(days => keep_days);

  delete from passes
   where source in ('gift','support') and status = 'unused'
     and use_by is not null and use_by < now() - make_interval(days => keep_days);

  delete from support_messages where created_at < now() - interval '90 days';
  delete from stripe_events    where processed_at < now() - interval '90 days';
  delete from rate_limits      where window_start < now() - interval '1 day';
  delete from admin_codes      where expires_at < now() - interval '1 day';
  delete from admin_sessions   where expires_at < now();
  delete from handoffs         where expires_at < now();
  delete from pairings         where expires_at < now() - interval '1 day';
  delete from plays_live       where slot_start < now() - interval '2 hours';
  delete from plays_hourly     where hour_start < now() - interval '400 days';
end;
$$;
