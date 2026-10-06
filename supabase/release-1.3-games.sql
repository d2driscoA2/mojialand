-- Release 1.3 (October 2026): play counts for the 2 new games, Share Party and Feelings Faces.
-- Run on mojialand-staging before games-1.3 merges into staging, then on mojialand-live
-- only after Danny's typed OK and before the merge to main. Safe to run twice.
-- Counts stay the same shape: a city, a state, a game, a number. Nothing about the child.
alter table public.plays_hourly drop constraint if exists plays_hourly_game_check;
alter table public.plays_hourly add constraint plays_hourly_game_check
  check (game in ('pattern','bounce','match','parade','draw','share','feelings'));
alter table public.plays_live drop constraint if exists plays_live_game_check;
alter table public.plays_live add constraint plays_live_game_check
  check (game in ('pattern','bounce','match','parade','draw','share','feelings'));
-- Check: exactly 2 rows, both listing share and feelings. A third row means an older rule
-- with another name is still there; stop and tell Claude.
select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid) as rule
  from pg_constraint
 where contype = 'c' and conrelid in ('public.plays_hourly'::regclass, 'public.plays_live'::regclass)
   and pg_get_constraintdef(oid) like '%game%';
