-- Run once in the Supabase SQL editor (staging first, live after approval).
-- Same text as the Analytics section at the end of schema.sql. Safe to run again.

-- ============================================================================
-- Analytics (September 29, 2026). Counts only. No person, device, session,
-- IP address, ZIP code or coordinates is ever stored. Every row is a total
-- for one hour (or one 5-minute slot) in one city for one game.
-- ============================================================================

-- Plays per hour. opens = games opened. b0..b3 = games closed after
-- under 2, 2 to 5, 5 to 15, and 15 plus minutes (ranges, never exact times).
create table if not exists public.plays_hourly (
  hour_start timestamptz not null,
  country    text not null default '',
  state      text not null default '',
  city       text not null default '',
  game       text not null check (game in ('pattern','bounce','match','parade','draw')),
  mode       text not null check (mode in ('app','web')),
  opens      integer not null default 0,
  b0         integer not null default 0,
  b1         integer not null default 0,
  b2         integer not null default 0,
  b3         integer not null default 0,
  primary key (hour_start, country, state, city, game, mode)
);

-- Games open per 5-minute slot, for the live view. Kept 2 hours.
create table if not exists public.plays_live (
  slot_start timestamptz not null,
  country    text not null default '',
  state      text not null default '',
  city       text not null default '',
  game       text not null check (game in ('pattern','bounce','match','parade','draw')),
  n          integer not null default 0,
  primary key (slot_start, country, state, city, game)
);

-- Campaigns the admin makes. The label goes in the QR link: /?c=label
create table if not exists public.campaigns (
  label      text primary key check (label ~ '^[a-z0-9][a-z0-9-]{1,23}$'),
  name       text not null,
  note       text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Campaign results per hour. event: open (first QR open on a device),
-- play (first game after that), gift (gift code used), pass48, forever.
-- days_sum adds up days from QR open to purchase, for the average.
create table if not exists public.campaign_hourly (
  hour_start timestamptz not null,
  label      text not null references public.campaigns(label) on delete cascade,
  country    text not null default '',
  state      text not null default '',
  city       text not null default '',
  event      text not null check (event in ('open','play','gift','pass48','forever')),
  n          integer not null default 0,
  days_sum   numeric not null default 0,
  primary key (hour_start, label, country, state, city, event)
);

alter table public.plays_hourly    enable row level security;
alter table public.plays_live      enable row level security;
alter table public.campaigns       enable row level security;
alter table public.campaign_hourly enable row level security;
revoke all on public.plays_hourly, public.plays_live, public.campaigns, public.campaign_hourly from anon, authenticated;
grant select, insert, update, delete on public.plays_hourly, public.plays_live, public.campaigns, public.campaign_hourly to service_role;

-- One call per ping. p_open adds a game open (hour and live slot),
-- p_live adds a still-playing mark (live slot only), p_bucket 0..3 adds a close.
create or replace function public.analytics_add(
  p_country text, p_state text, p_city text, p_game text, p_mode text,
  p_open int, p_live int, p_bucket int
) returns void language plpgsql security definer set search_path = public as $$
declare
  h timestamptz := date_trunc('hour', now());
  s timestamptz := to_timestamp(floor(extract(epoch from now()) / 300) * 300);
begin
  if p_open > 0 or p_bucket between 0 and 3 then
    insert into plays_hourly as t (hour_start, country, state, city, game, mode, opens, b0, b1, b2, b3)
    values (h, p_country, p_state, p_city, p_game, p_mode, greatest(p_open,0),
            (p_bucket = 0)::int, (p_bucket = 1)::int, (p_bucket = 2)::int, (p_bucket = 3)::int)
    on conflict (hour_start, country, state, city, game, mode) do update set
      opens = t.opens + excluded.opens, b0 = t.b0 + excluded.b0, b1 = t.b1 + excluded.b1,
      b2 = t.b2 + excluded.b2, b3 = t.b3 + excluded.b3;
  end if;
  if p_open > 0 or p_live > 0 then
    insert into plays_live as t (slot_start, country, state, city, game, n)
    values (s, p_country, p_state, p_city, p_game, 1)
    on conflict (slot_start, country, state, city, game) do update set n = t.n + 1;
  end if;
end $$;

-- Counts one campaign event. Unknown or paused labels count nothing.
create or replace function public.campaign_add(
  p_label text, p_country text, p_state text, p_city text, p_event text, p_days numeric
) returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from campaigns where label = p_label and active) then return false; end if;
  insert into campaign_hourly as t (hour_start, label, country, state, city, event, n, days_sum)
  values (date_trunc('hour', now()), p_label, p_country, p_state, p_city, p_event, 1, coalesce(p_days, 0))
  on conflict (hour_start, label, country, state, city, event) do update set
    n = t.n + 1, days_sum = t.days_sum + excluded.days_sum;
  return true;
end $$;

-- History for the admin, grouped by local day and by local hour of day.
-- Returns one JSON value so the 1,000-row API limit never cuts it short.
create or replace function public.analytics_history(p_from timestamptz, p_tz text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'days', coalesce((select jsonb_agg(x) from (
      select to_char(hour_start at time zone p_tz, 'YYYY-MM-DD') as d, country as co, state as st, city as ci, game as g, mode as m,
             sum(opens)::int as o, sum(b0)::int as b0, sum(b1)::int as b1, sum(b2)::int as b2, sum(b3)::int as b3
        from plays_hourly where hour_start >= p_from
       group by 1, 2, 3, 4, 5, 6) x), '[]'::jsonb),
    'hours', coalesce((select jsonb_agg(y) from (
      select extract(hour from hour_start at time zone p_tz)::int as h, country as co, state as st, city as ci, game as g,
             sum(opens)::int as o
        from plays_hourly where hour_start >= p_from
       group by 1, 2, 3, 4, 5) y), '[]'::jsonb)
  );
$$;

-- Campaign results for the admin, by local day and by place.
create or replace function public.campaign_stats(p_tz text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'campaigns', coalesce((select jsonb_agg(c order by c.created_at desc) from campaigns c), '[]'::jsonb),
    'days', coalesce((select jsonb_agg(x) from (
      select label as l, to_char(hour_start at time zone p_tz, 'YYYY-MM-DD') as d, event as e,
             sum(n)::int as n, sum(days_sum)::numeric as ds
        from campaign_hourly group by 1, 2, 3) x), '[]'::jsonb),
    'places', coalesce((select jsonb_agg(y) from (
      select label as l, country as co, state as st, city as ci, sum(n)::int as n
        from campaign_hourly where event = 'open' group by 1, 2, 3, 4) y), '[]'::jsonb)
  );
$$;

revoke all on function public.analytics_add(text,text,text,text,text,int,int,int) from public, anon, authenticated;
revoke all on function public.campaign_add(text,text,text,text,text,numeric) from public, anon, authenticated;
revoke all on function public.analytics_history(timestamptz,text) from public, anon, authenticated;
revoke all on function public.campaign_stats(text) from public, anon, authenticated;
grant execute on function public.analytics_add(text,text,text,text,text,int,int,int) to service_role;
grant execute on function public.campaign_add(text,text,text,text,text,numeric) to service_role;
grant execute on function public.analytics_history(timestamptz,text) to service_role;
grant execute on function public.campaign_stats(text) to service_role;

-- Live slots older than 2 hours go every 15 minutes. Hourly totals older
-- than 400 days go in the nightly cleanup below.
create or replace function public.analytics_cleanup() returns void
language sql security definer set search_path = public as $$
  delete from plays_live where slot_start < now() - interval '2 hours';
$$;
revoke all on function public.analytics_cleanup() from public, anon, authenticated;

select cron.unschedule('mojialand-analytics-cleanup')
 where exists (select 1 from cron.job where jobname = 'mojialand-analytics-cleanup');
select cron.schedule('mojialand-analytics-cleanup', '*/15 * * * *',
                     $$select public.analytics_cleanup()$$);

-- Nightly cleanup, now also dropping hourly play totals older than 400 days.
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
