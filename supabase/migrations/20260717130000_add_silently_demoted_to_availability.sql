-- Additive only, existing table. No new grants needed -- the table-level
-- GRANT already applied to service_role/authenticated covers new columns
-- automatically. Existing rows default to false (the normal case for
-- every row that was never silently demoted by Case C).

alter table public.availability
  add column silently_demoted boolean not null default false;

comment on column public.availability.silently_demoted is
  'True if this player was silently moved from confirmed to tentative by '
  'Case C (lib/sub-requests.js) and never notified. Checked and cleared at '
  'promotion time to decide whether the promotion email should be sent.';