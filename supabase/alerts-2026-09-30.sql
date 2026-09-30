-- Release 1.1 #23: phone alerts for the admin. Run once on staging, then on live.
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
