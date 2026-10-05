-- Release 1.1.1 #39 (audit M1, October 2026): server handoff removed.
-- Run on mojialand-staging first, then on mojialand-live only after Danny's OK.
-- Safe to run twice.
-- Live: deletes the old handoffs rows (they held plain pass codes for up to
-- 30 minutes). Nothing writes the table any more.
-- Staging: also removes the pairing number table and function, built and then
-- dropped the same week (Danny, October 5: no pairing number anywhere), and
-- puts the nightly cleanup back to its live version.
delete from public.handoffs;
drop function if exists public.pair_claim(text, text);
drop table if exists public.pairings;

-- Nightly cleanup without the pairings line (needed after the table is dropped).
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
  delete from plays_live       where slot_start < now() - interval '2 hours';
  delete from plays_hourly     where hour_start < now() - interval '400 days';
end;
$$;
