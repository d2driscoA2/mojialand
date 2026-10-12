-- Release 1.4 (Danny, October 12, choice A): admin Refund returns every payment on a pass.
-- Add and upgrade checkouts now record which pass they paid for and how much, so the
-- admin can refund all of them and show the total paid. The link to the pass goes away
-- when nightly cleanup deletes the pass (on delete set null). No email, no code.
-- Run on mojialand-staging first, then on mojialand-live only after Danny's typed OK. Safe to run twice.

alter table public.granted_checkouts add column if not exists pass_id uuid references public.passes(id) on delete set null;
alter table public.granted_checkouts add column if not exists amount_cents integer;
create index if not exists granted_checkouts_pass_idx on public.granted_checkouts (pass_id);
