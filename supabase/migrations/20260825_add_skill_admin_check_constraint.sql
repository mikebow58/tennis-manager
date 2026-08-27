-- 20260825_add_skill_range_check_constraints.sql
--
-- Defense-in-depth following the discovery that lib/utils.js's SKILL_LABELS
-- dictionary had been left on the pre-V2 10-point scale for months with no
-- database-level constraint to catch it. Adding equivalent protection for
-- skill_self at the same time, even though its current dropdown
-- (app/admin/players/new/page.js) is already correctly implemented as
-- 1-5 — the goal is to make a stale/incorrect dropdown structurally unable
-- to write bad data, not to fix a bug that exists there today.
--
-- Both columns are nullable (skill_self may be unset before registration;
-- skill_admin may be unset before the organiser rates a player), so both
-- constraints explicitly permit NULL.
--
-- Dev only for now — bundle into the pending production skill-scale
-- migration (1-10 -> 1-8 rewrite) when that runs, rather than treating
-- this as a separate production touch.

begin;

alter table players
  add constraint skill_admin_range_check
  check (skill_admin is null or (skill_admin >= 1 and skill_admin <= 8));

alter table players
  add constraint skill_self_range_check
  check (skill_self is null or (skill_self >= 1 and skill_self <= 5));

commit;