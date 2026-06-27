-- 20260622000000_add_partner_setting.sql
--
-- Adds partner_setting to court_assignments to store the organiser's
-- per-court partner behaviour override set on the review screen.
--
-- Values: 'switch_partners' | 'paired_rotation' (keep partners)
-- Nullable: historical rows and incomplete courts have no value;
--   the print sheet and email logic fall back to session.format when null.
--
-- Run after 20260616000000_add_team_number.sql.

ALTER TABLE court_assignments ADD COLUMN partner_setting text;
ALTER TABLE court_assignments
  ADD CONSTRAINT court_assignments_partner_setting_valid
  CHECK (partner_setting IS NULL OR partner_setting IN ('switch_partners', 'paired_rotation'));