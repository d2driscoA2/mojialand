-- Release 1.5 (October 2026): 90-day gift and support codes (Danny, October 16). Never sold.
-- Run on mojialand-staging first, then on mojialand-live only after Danny's typed OK. Safe to run twice.
-- Run order: after release-1.5-codes.sql. Written with $$ in place of quote marks, because the Supabase editor turns pasted quotes curly.
alter table public.passes drop constraint if exists passes_kind_check;
alter table public.passes add constraint passes_kind_check
  check (kind in ($$48h$$, $$30d$$, $$7d$$, $$90d$$, $$holder$$, $$forever$$));

-- Check: one row, passes_kind_check, naming 90d.
select conname, pg_get_constraintdef(oid) as rule from pg_constraint where conname = $$passes_kind_check$$;
