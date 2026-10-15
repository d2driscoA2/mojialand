-- Release 1.5 #66 (October 2026): counts of visits from blocked countries and regions.
-- Each row: one hour, one country, one region (Ukraine regions only, else empty), one kind, a number.
-- kind: page (an open of the blocked page) or the name of the server function that refused the call.
-- No IP address, city, device or person is stored.
-- Run on mojialand-staging first, then on mojialand-live only after Danny's typed OK. Safe to run twice.
-- Written with $$ in place of quote marks, because the Supabase editor turns pasted quotes curly.

create table if not exists public.blocked_hourly (
  hour_start timestamptz not null,
  country    text not null check (country ~ $$^[A-Z]{2}$$),
  region     text not null default $$$$,
  kind       text not null check (kind in ($$page$$, $$create-checkout$$, $$confirm-session$$, $$pass-check$$,
                                           $$redeem-code$$, $$gifts$$, $$friend-code$$, $$ping$$, $$contact$$, $$settings$$)),
  n          integer not null default 0,
  primary key (hour_start, country, region, kind)
);
alter table public.blocked_hourly enable row level security;
revoke all on public.blocked_hourly from anon, authenticated;
grant select, insert, update, delete on public.blocked_hourly to service_role;

-- Adds one count.
create or replace function public.blocked_add(p_country text, p_region text, p_kind text) returns void
language plpgsql security definer set search_path = public as $f$
begin
  insert into blocked_hourly as t (hour_start, country, region, kind, n)
  values (date_trunc($$hour$$, now()), upper(left(p_country, 2)), coalesce(left(p_region, 6), $$$$), p_kind, 1)
  on conflict (hour_start, country, region, kind) do update set n = t.n + 1;
end $f$;
revoke all on function public.blocked_add(text, text, text) from public, anon, authenticated;
grant execute on function public.blocked_add(text, text, text) to service_role;

-- Totals since p_from, one row per country, region and kind.
create or replace function public.blocked_stats(p_from timestamptz) returns jsonb
language sql stable security definer set search_path = public as $f$
  select coalesce(jsonb_agg(jsonb_build_object($$c$$, country, $$r$$, region, $$k$$, kind, $$n$$, total) order by total desc), $$[]$$::jsonb)
    from (select country, region, kind, sum(n)::int as total
            from blocked_hourly where hour_start >= p_from
           group by country, region, kind) x
$f$;
revoke all on function public.blocked_stats(timestamptz) from public, anon, authenticated;
grant execute on function public.blocked_stats(timestamptz) to service_role;

-- Check: one row, blocked_hourly, with rls_on true.
select relname as table_name, relrowsecurity as rls_on from pg_class where relname = $$blocked_hourly$$;
