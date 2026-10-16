-- Release 1.5 #67 (October 2026): fast batch and gift counts, and the cleanup gap for ended Forever gift codes.
-- Run on mojialand-staging first, then on mojialand-live only after Danny's typed OK. Safe to run twice.
-- Written with $$ in place of quote marks, because the Supabase editor turns pasted quotes curly.

-- One row per batch label (FRIEND excluded): codes, used, open, ended before use, first made, days to first use.
create or replace function public.batch_stats() returns jsonb
language sql stable security definer set search_path = public as $f$
  select coalesce(jsonb_agg(jsonb_build_object(
           $$b$$, batch, $$codes$$, codes, $$used$$, used, $$open$$, open, $$voided$$, voided,
           $$made$$, made, $$ds$$, ds, $$dn$$, used)), $$[]$$::jsonb)
    from (select batch,
                 count(*)::int as codes,
                 (count(*) filter (where status <> $$unused$$ and starts_at is not null))::int as used,
                 (count(*) filter (where status = $$unused$$))::int as open,
                 (count(*) filter (where status <> $$unused$$ and starts_at is null))::int as voided,
                 min(created_at) as made,
                 coalesce(sum(greatest(0, extract(epoch from (starts_at - created_at)) / 86400))
                          filter (where status <> $$unused$$ and starts_at is not null), 0)::float as ds
            from passes
           where batch is not null and batch <> $$FRIEND$$
           group by batch) x
$f$;
revoke all on function public.batch_stats() from public, anon, authenticated;
grant execute on function public.batch_stats() to service_role;

-- Gifts tab totals in one step: gifts made, on, open, expired; rounds; givers; holders; passes bought after a gift;
-- and the top 100 givers with their gift counts. Never device values, places or who gifted whom.
create or replace function public.gifts_summary() returns jsonb
language sql stable security definer set search_path = public as $f$
  with g as (
    select giver_id, gen, status, starts_at, use_by,
           (status <> $$unused$$ and starts_at is not null) as is_on,
           (status = $$unused$$ and use_by is not null and use_by < now()) as is_expired
      from passes where batch = $$FRIEND$$ and kind = $$7d$$
  ), gv as (
    select giver_id, count(*)::int as made, (count(*) filter (where is_on))::int as on_n,
           (count(*) filter (where status = $$unused$$ and not is_expired))::int as left_n
      from g where giver_id is not null group by giver_id
  )
  select jsonb_build_object(
    $$totals$$, (select jsonb_build_object($$made$$, count(*), $$on$$, count(*) filter (where is_on),
                   $$open$$, count(*) filter (where status = $$unused$$ and not is_expired),
                   $$expired$$, count(*) filter (where is_expired)) from g),
    $$rounds$$, (select coalesce(jsonb_agg(jsonb_build_object($$round$$, r, $$made$$, made, $$on$$, on_n) order by r), $$[]$$::jsonb)
                   from (select greatest(1, coalesce(gen, 1)) as r, count(*)::int as made, (count(*) filter (where is_on))::int as on_n
                           from g group by 1) rr),
    $$givers$$, (select count(*) from gv),
    $$reward_days$$, (select coalesce(sum(p.reward_days), 0) from gv join passes p on p.id = gv.giver_id),
    $$holders$$, (select count(*) from passes where kind = $$holder$$),
    $$bought$$, (select jsonb_build_object($$passes$$, count(*), $$forever$$, count(*) filter (where kind = $$forever$$),
                   $$cents$$, coalesce(sum(amount_cents), 0)) from passes where from_gift and source = $$stripe$$),
    $$top$$, (select coalesce(jsonb_agg(t), $$[]$$::jsonb) from (
               select p.prefix, p.code_last4, p.kind, p.source, p.status, p.gen, p.reward_days, p.created_at,
                      gv.on_n as "on", gv.left_n as "left"
                 from gv join passes p on p.id = gv.giver_id
                order by gv.on_n desc, p.created_at desc limit 100) t)
  )
$f$;
revoke all on function public.gifts_summary() from public, anon, authenticated;
grant execute on function public.gifts_summary() to service_role;

-- Nightly cleanup, Release 1.5 changes: ended or refunded Forever gift and support codes now leave 30 days
-- after they end, like every other kind (paid Forever passes stay forever); blocked visit counts keep 400 days.
create or replace function public.nightly_cleanup() returns void
language plpgsql security definer set search_path = public as $f$
declare
  keep_days integer := coalesce((select (value)::text::integer from settings
                                 where key = $$delete_ended_after_days$$), 30);
begin
  update passes set status = $$ended$$
   where status = $$active$$ and ends_at is not null and ends_at < now();

  delete from passes
   where kind <> $$forever$$
     and status in ($$ended$$, $$refunded$$)
     and coalesce(ends_at, created_at) < now() - make_interval(days => keep_days);

  delete from passes
   where kind = $$forever$$ and source in ($$gift$$, $$support$$)
     and status in ($$ended$$, $$refunded$$)
     and coalesce(ends_at, created_at) < now() - make_interval(days => keep_days);

  delete from passes
   where source in ($$gift$$, $$support$$) and status = $$unused$$
     and use_by is not null and use_by < now() - make_interval(days => keep_days);

  delete from support_messages where created_at < now() - make_interval(days => 90);
  delete from stripe_events    where processed_at < now() - make_interval(days => 90);
  delete from rate_limits      where window_start < now() - make_interval(days => 1);
  delete from admin_codes      where expires_at < now() - make_interval(days => 1);
  delete from admin_sessions   where expires_at < now();
  delete from handoffs         where expires_at < now();
  delete from plays_live       where slot_start < now() - make_interval(hours => 2);
  delete from plays_hourly     where hour_start < now() - make_interval(days => 400);
  delete from blocked_hourly   where hour_start < now() - make_interval(days => 400);
end;
$f$;
revoke all on function public.nightly_cleanup() from public, anon, authenticated;

-- Check: 3 rows, batch_stats, gifts_summary, nightly_cleanup.
select proname from pg_proc where proname in ($$batch_stats$$, $$gifts_summary$$, $$nightly_cleanup$$) order by proname;
