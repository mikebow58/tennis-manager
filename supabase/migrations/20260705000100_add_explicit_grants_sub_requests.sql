-- Adds explicit grants for sub_requests and sub_request_recipients, per the
-- Supabase Data API default change (new tables not exposed to PostgREST
-- without explicit grants, enforced for existing projects from Oct 30, 2026).
-- Both tables are already receiving live writes (evaluateAndSendSubRequest),
-- so this project is currently on the pre-enforcement default. This migration
-- is preventive, ahead of the enforcement deadline — same pattern as
-- 20260515000000_explicit_grants_v2_tables.sql.
--
-- Safety review:
--   Touches existing rows? No — grants only, no data change.
--   Could it fail partway through? No — four independent grant statements.
--   Rollback plan: REVOKE the same grants if ever needed.

grant select, insert, update, delete on public.sub_requests to service_role;
grant select, insert, update, delete on public.sub_requests to authenticated;

grant select, insert, update, delete on public.sub_request_recipients to service_role;
grant select, insert, update, delete on public.sub_request_recipients to authenticated;
-- anon gets no access — intentional; see RLS Access Model