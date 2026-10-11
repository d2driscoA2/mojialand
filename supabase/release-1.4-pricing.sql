-- Release 1.4 #32 and #58 (October 2026): new pricing, gifts and the gift holder record.
-- Run on mojialand-staging first, then on mojialand-live only after Danny's typed OK.
-- Safe to run twice. No row is deleted and no existing pass changes.
--
-- Pass kinds:
--   48h      old 48-hour pass (running passes and printed cards from before 1.4 keep working)
--   30d      30-day pass, $4.99, never renews by itself
--   7d       gift of 7 free days (from a family's 3 gifts, or a printed card made from 1.4 on)
--   holder   gift holder: a free-week family that tapped Give a friend. No email, no name.
--            Made only on that tap. Its end time is the free week end plus reward days.
--   forever  Forever
-- Columns for gifts (counts, never people):
--   giver_id     the pass that gave this gift, so the giver gets 7 reward days on first use
--   reward_days  reward days earned by this pass as a giver (0 to 21)
--   gen          0 for a family who started alone, giver gen + 1 for a gift
--   from_gift    a paid pass bought on a device that started from a gift (yes or no only)

alter table public.passes drop constraint if exists passes_kind_check;
alter table public.passes add constraint passes_kind_check check (kind in ('48h','30d','7d','holder','forever'));
alter table public.passes drop constraint if exists passes_source_check;
alter table public.passes add constraint passes_source_check check (source in ('stripe','gift','support','free'));

alter table public.passes add column if not exists giver_id uuid references public.passes(id) on delete set null;
alter table public.passes add column if not exists reward_days smallint not null default 0;
alter table public.passes add column if not exists gen smallint not null default 0;
alter table public.passes add column if not exists from_gift boolean not null default false;
create index if not exists passes_giver_idx on public.passes (giver_id);

-- Free week in place of 15 first-visit minutes (the game reads free_days; first_visit_minutes stays for old builds).
insert into public.settings (key, value, help) values
  ('free_days', '7', 'Free days of unlimited play from the first open on a device. Then the daily minutes.')
on conflict (key) do nothing;
update public.settings set help = 'Days after a 30-day or 48-hour pass ends that its price still counts toward Forever.' where key = 'credit_days';
update public.settings set help = 'Days after a timed pass ends before its record and email are deleted.' where key = 'delete_ended_after_days';
update public.settings set help = 'Yellow timer chip this many minutes before a timed pass ends.' where key = 'warning_minutes';

-- Nightly cleanup: every timed kind (not only 48h) is deleted 30 days after it ends.
create or replace function public.nightly_cleanup() returns void
language plpgsql security definer set search_path = public as $$
declare
  keep_days integer := coalesce((select (value)::text::integer from settings
                                 where key = 'delete_ended_after_days'), 30);
begin
  update passes set status = 'ended'
   where status = 'active' and ends_at is not null and ends_at < now();

  delete from passes
   where kind <> 'forever'
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
  delete from plays_live       where slot_start < now() - interval '2 hours';
  delete from plays_hourly     where hour_start < now() - interval '400 days';
end;
$$;
revoke all on function public.nightly_cleanup() from public, anon, authenticated;

-- Giver reward in one locked step: 7 days, at most 21 in total, never on a refunded or disputed pass.
-- Returns the new reward_days, or -1 when nothing changed.
create or replace function public.gift_reward(p_giver uuid, p_days int, p_cap int) returns int
language plpgsql security definer set search_path = public as $$
declare r passes%rowtype; base timestamptz;
begin
  select * into r from passes where id = p_giver for update;
  if not found or r.status in ('refunded','disputed') or r.kind = 'forever' or r.reward_days >= p_cap then return -1; end if;
  base := greatest(now(), coalesce(r.ends_at, now()));
  update passes set ends_at = base + make_interval(days => p_days),
                    reward_days = least(p_cap, r.reward_days + p_days),
                    status = 'active'
   where id = p_giver;
  return least(p_cap, r.reward_days + p_days);
end $$;
revoke all on function public.gift_reward(uuid, int, int) from public, anon, authenticated;
grant execute on function public.gift_reward(uuid, int, int) to service_role;
