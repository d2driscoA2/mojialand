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
