-- Release 1.1.1 #40 (audit M2, October 2026): device count in one step.
-- Run on mojialand-staging first, then on mojialand-live only after Danny's OK.
-- Safe to run twice. A per-pass lock makes the check and the insert one step,
-- so parallel requests never put a pass on more devices than its limit.
create or replace function public.device_add(p_pass uuid, p_hash text, p_limit int) returns text
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform pg_advisory_xact_lock(hashtext('mojia_dev:' || p_pass::text));
  if exists (select 1 from devices where pass_id = p_pass and device_id_hash = p_hash) then return 'ok'; end if;
  select count(*) into n from devices where pass_id = p_pass;
  if n >= p_limit then return 'limit'; end if;
  insert into devices (pass_id, device_id_hash) values (p_pass, p_hash) on conflict do nothing;
  return 'ok';
end $$;
revoke all on function public.device_add(uuid, text, int) from public, anon, authenticated;
grant execute on function public.device_add(uuid, text, int) to service_role;
