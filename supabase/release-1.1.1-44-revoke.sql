-- Release 1.1.1 #44 L7 (audit, October 2026): the explicit revoke the other
-- tables have. Row level security already locks these tables; this matches.
-- Run on mojialand-staging first, then on mojialand-live only after Danny's OK.
-- Safe to run twice.
revoke all on public.push_subs, public.alert_counts from public, anon, authenticated;
