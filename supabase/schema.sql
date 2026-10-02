-- Mojialand payments database. Staging and live use the same schema.
-- Only Netlify Functions reach these tables, using the service key.
-- Every table has Row Level Security on and no public policies,
-- so the public (anon) key and signed-in users see nothing.

-- Passes: paid passes, gift codes, and support codes.
-- Codes are never stored. Only a SHA-256 hash (with a secret pepper)
-- plus the last 4 characters for the admin screen.
create table if not exists public.passes (
  id                uuid primary key default gen_random_uuid(),
  code_hash         text not null unique,
  code_last4        text not null,
  prefix            text not null check (prefix in ('MOJI','GIFT')),
  kind              text not null check (kind in ('48h','forever')),
  source            text not null check (source in ('stripe','gift','support')),
  email             text,
  stripe_session_id text unique,
  amount_cents      integer not null default 0,
  created_at        timestamptz not null default now(),
  starts_at         timestamptz,          -- gift codes start on first use
  ends_at           timestamptz,          -- null for forever
  device_limit      integer not null default 5,
  status            text not null default 'active'
                    check (status in ('active','ended','unused','refunded','disputed')),
  uses_left         integer,              -- gift codes that work more than once
  use_by            timestamptz,          -- gift code expiry
  note              text
);
create index if not exists passes_email_idx   on public.passes (lower(email));
create index if not exists passes_ends_at_idx on public.passes (ends_at);

-- Devices: counts devices per pass. Stores only a hash of a random
-- device value the game makes. Nothing about the child.
create table if not exists public.devices (
  id             uuid primary key default gen_random_uuid(),
  pass_id        uuid not null references public.passes(id) on delete cascade,
  device_id_hash text not null,
  added_at       timestamptz not null default now(),
  unique (pass_id, device_id_hash)
);

-- Stripe events already handled. Stops a retried webhook from
-- creating a second pass.
create table if not exists public.stripe_events (
  event_id     text primary key,
  session_id   text,
  processed_at timestamptz not null default now()
);

-- Contact form messages. Deleted after 90 days.
create table if not exists public.support_messages (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  topic      text not null,
  message    text,
  created_at timestamptz not null default now(),
  status     text not null default 'open' check (status in ('open','done'))
);

-- Rate limits for create-checkout, redeem-code, and contact.
-- The key holds a hash of the network address, never the address itself.
create table if not exists public.rate_limits (
  key          text not null,
  window_start timestamptz not null,
  hits         integer not null default 1,
  primary key (key, window_start)
);

-- Settings the admin page edits. The game reads them through a function.
create table if not exists public.settings (
  key        text primary key,
  value      jsonb not null,
  help       text,
  updated_at timestamptz not null default now()
);

insert into public.settings (key, value, help) values
  ('first_visit_minutes',     '15',      'Free play on the first visit to a device.'),
  ('daily_minutes',           '3',       'Free play each day after the first visit.'),
  ('daily_reset',             '"04:00"', 'Local time free play comes back each day.'),
  ('devices_per_code',        '5',       'Devices one code works on.'),
  ('warning_minutes',         '10',      'Yellow timer chip this many minutes before a 48-hour pass ends.'),
  ('credit_days',             '7',       'Days after a 48-hour pass ends that its $1.50 still counts toward Forever.'),
  ('delete_ended_after_days', '30',      'Days after a 48-hour pass ends before its record and email are deleted.')
on conflict (key) do nothing;

-- Lock every table. RLS on, no policies: only the service key gets in.
alter table public.passes           enable row level security;
alter table public.devices          enable row level security;
alter table public.stripe_events    enable row level security;
alter table public.support_messages enable row level security;
alter table public.rate_limits      enable row level security;
alter table public.settings         enable row level security;

revoke all on public.passes, public.devices, public.stripe_events,
  public.support_messages, public.rate_limits, public.settings
  from anon, authenticated;

-- Nightly cleanup at 08:00 UTC (4:00 AM Michigan time).
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
end;
$$;

revoke all on function public.nightly_cleanup() from public, anon, authenticated;

create extension if not exists pg_cron;

select cron.unschedule('mojialand-nightly-cleanup')
 where exists (select 1 from cron.job where jobname = 'mojialand-nightly-cleanup');

select cron.schedule('mojialand-nightly-cleanup', '0 8 * * *',
                     $$select public.nightly_cleanup()$$);

-- Payments step 2 (checkout). Safe to run more than once.
-- emailed_at: when the code email went out, so a retried webhook never sends twice.
alter table public.passes add column if not exists emailed_at timestamptz;

-- Rate limiter used by the functions. Counts hits per hashed key per window.
create or replace function public.rate_hit(p_key text, p_window_seconds int, p_limit int) returns boolean language plpgsql security definer set search_path=public as $$ declare w timestamptz := to_timestamp(floor(extract(epoch from now())/p_window_seconds)*p_window_seconds); n int; begin insert into rate_limits(key,window_start,hits) values(p_key,w,1) on conflict (key,window_start) do update set hits=rate_limits.hits+1 returning hits into n; return n<=p_limit; end $$;
revoke all on function public.rate_hit(text,int,int) from public, anon, authenticated; grant execute on function public.rate_hit(text,int,int) to service_role;

-- The functions use the service key (service_role). "Auto expose new tables"
-- is off in this project, so service_role needs explicit table rights.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.passes, public.devices, public.stripe_events,
  public.support_messages, public.rate_limits, public.settings to service_role;

-- Admin sign-in (email code). Codes and session tokens are stored only as hashes.
create table if not exists public.admin_codes (
  id         uuid primary key default gen_random_uuid(),
  code_hash  text not null,
  expires_at timestamptz not null,
  tries      integer not null default 0,
  used       boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.admin_sessions (
  token_hash text primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.admin_codes    enable row level security;
alter table public.admin_sessions enable row level security;
revoke all on public.admin_codes, public.admin_sessions from anon, authenticated;
grant select, insert, update, delete on public.admin_codes, public.admin_sessions to service_role;

-- Nightly cleanup also drops old sign-in rows.
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
end;
$$;

-- Home Screen handoff. When a pass is on in Safari, the game parks a signed
-- pass token here under a scrambled key made from the network address and
-- browser type. The Home Screen app (separate storage on iPhone) claims it
-- within 30 minutes. Rows die on claim or by the nightly cleanup.
create table if not exists public.handoffs (
  key_hash   text primary key,
  token      text not null,
  code       text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.handoffs enable row level security;
revoke all on public.handoffs from anon, authenticated;
grant select, insert, update, delete on public.handoffs to service_role;

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

-- Release 1.1 #3 (September 30, 2026): batch label on passes. FRIEND marks a
-- friend pass (one per parent pass, made from the parent pass ID, never stored).
-- Counts codes, never people.
alter table public.passes add column if not exists batch text;
create index if not exists passes_batch_idx on public.passes (batch);

-- push_subs: the admin phones that asked for alerts (a push service address and its keys, no names).
-- alert_counts: daily totals for the evening summary (a day, a kind, a batch label, a number).
create table if not exists public.push_subs (
  endpoint   text primary key,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.alert_counts (
  day   date not null,
  kind  text not null,
  label text not null default '',
  n     integer not null default 0,
  primary key (day, kind, label)
);
alter table public.push_subs    enable row level security;
alter table public.alert_counts enable row level security;
grant select, insert, update, delete on public.push_subs, public.alert_counts to service_role;

create or replace function public.alert_add(p_day date, p_kind text, p_label text) returns integer
language plpgsql security definer set search_path=public as $$
declare v integer;
begin
  insert into alert_counts(day, kind, label, n) values (p_day, left(p_kind, 16), left(coalesce(p_label, ''), 24), 1)
  on conflict (day, kind, label) do update set n = alert_counts.n + 1 returning n into v;
  return v;
end $$;
revoke all on function public.alert_add(date, text, text) from public, anon, authenticated;
grant execute on function public.alert_add(date, text, text) to service_role;

insert into public.settings (key, value, help) values ('alerts_mode', '"each"', 'Phone alerts: each, daily, or off.')
on conflict (key) do nothing;

-- Daily totals older than 400 days go, same as play totals.
select cron.schedule('alert-counts-cleanup', '10 8 * * *', $$delete from public.alert_counts where day < current_date - 400$$);

-- Release 1.1.1 #38 (audit H2, October 2026): admin sign-in hardening.
-- Run on mojialand-staging first, then on mojialand-live only after Danny's OK.
-- Safe to run twice.
--
-- admin_code_check counts each try in one step before the compare, so parallel
-- guesses never pass 5 tries on one code. After 20 failed tries in one hour
-- from all networks, sign-in locks for 1 hour (row key 'admin-lock' in
-- rate_limits) and every open code is cancelled. admin_code_new cancels every
-- older code, so only one code is open at a time.

create or replace function public.admin_locked() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from rate_limits
                  where key = 'admin-lock' and window_start > now() - interval '1 hour');
$$;

create or replace function public.admin_code_new(p_id uuid, p_hash text, p_expires timestamptz) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('mojia_admin_code'));
  if public.admin_locked() then return false; end if;
  update admin_codes set used = true where used = false;
  insert into admin_codes (id, code_hash, expires_at) values (p_id, p_hash, p_expires);
  return true;
end $$;

create or replace function public.admin_code_check(p_id uuid, p_hash text) returns text
language plpgsql security definer set search_path = public as $$
declare h text; n int;
begin
  if public.admin_locked() then return 'locked'; end if;
  update admin_codes set tries = tries + 1
   where id = p_id and used = false and tries < 5 and expires_at > now()
   returning code_hash into h;
  if h is not null and h = p_hash then
    update admin_codes set used = true where id = p_id and used = false;
    if found then return 'ok'; end if;
  end if;
  insert into rate_limits (key, window_start, hits) values ('admin-fail', date_trunc('hour', now()), 1)
    on conflict (key, window_start) do update set hits = rate_limits.hits + 1
    returning hits into n;
  if n > 20 then
    insert into rate_limits (key, window_start, hits) values ('admin-lock', now(), 1)
      on conflict (key, window_start) do nothing;
    update admin_codes set used = true where used = false;
    if n = 21 then return 'lockednow'; end if;
    return 'locked';
  end if;
  return 'bad';
end $$;

revoke all on function public.admin_locked() from public, anon, authenticated;
revoke all on function public.admin_code_new(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_code_check(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_locked() to service_role;
grant execute on function public.admin_code_new(uuid, text, timestamptz) to service_role;
grant execute on function public.admin_code_check(uuid, text) to service_role;
