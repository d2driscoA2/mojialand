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
