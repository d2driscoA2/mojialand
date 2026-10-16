-- Release 1.5 #64 (October 2026): website visits for admin Analytics. Counts only, like plays.
-- Each row: one hour, a country, state and city, an event (visit, play, pass), a source (visits only), a number.
-- No IP address, device, cookie, full address or person is stored. Sources are site names from a fixed list.
-- Run on mojialand-staging first, then on mojialand-live only after Danny's typed OK. Safe to run twice.
-- Run after release-1.5-blocked.sql and before release-1.5-codes.sql (its nightly cleanup removes old rows here).
-- Written with $$ in place of quote marks, because the Supabase editor turns pasted quotes curly.

create table if not exists public.site_hourly (
  hour_start timestamptz not null,
  country    text not null default $$$$,
  state      text not null default $$$$,
  city       text not null default $$$$,
  event      text not null check (event in ($$visit$$, $$play$$, $$pass$$)),
  source     text not null default $$$$ check (source in ($$$$, $$typed$$, $$qr$$, $$google$$, $$bing$$, $$duckduckgo$$, $$yahoo$$,
                 $$facebook$$, $$instagram$$, $$tiktok$$, $$youtube$$, $$x$$, $$linkedin$$, $$pinterest$$, $$reddit$$, $$other$$)),
  n          integer not null default 0,
  primary key (hour_start, country, state, city, event, source)
);
alter table public.site_hourly enable row level security;
revoke all on public.site_hourly from anon, authenticated;
grant select, insert, update, delete on public.site_hourly to service_role;

create or replace function public.site_add(p_country text, p_state text, p_city text, p_event text, p_source text) returns void
language plpgsql security definer set search_path = public as $f$
begin
  insert into site_hourly as t (hour_start, country, state, city, event, source, n)
  values (date_trunc($$hour$$, now()), coalesce(p_country, $$$$), coalesce(p_state, $$$$), coalesce(p_city, $$$$), p_event, coalesce(p_source, $$$$), 1)
  on conflict (hour_start, country, state, city, event, source) do update set n = t.n + 1;
end $f$;
revoke all on function public.site_add(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.site_add(text, text, text, text, text) to service_role;

-- Totals since p_from by local day, plus passes bought in the same time.
create or replace function public.site_stats(p_from timestamptz, p_tz text) returns jsonb
language sql stable security definer set search_path = public as $f$
  select jsonb_build_object(
    $$days$$, coalesce((select jsonb_agg(x) from (
      select to_char(hour_start at time zone p_tz, $$YYYY-MM-DD$$) as d, country as co, state as st, city as ci,
             event as s, source as r, sum(n)::int as n
        from site_hourly where hour_start >= p_from
       group by 1, 2, 3, 4, 5, 6) x), $$[]$$::jsonb),
    $$bought$$, (select count(*) from passes where source = $$stripe$$ and created_at >= p_from)
  )
$f$;
revoke all on function public.site_stats(timestamptz, text) from public, anon, authenticated;
grant execute on function public.site_stats(timestamptz, text) to service_role;

-- Check: one row, site_hourly, with rls_on true.
select relname as table_name, relrowsecurity as rls_on from pg_class where relname = $$site_hourly$$;
