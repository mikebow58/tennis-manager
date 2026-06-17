-- 20260616000000_add_team_number.sql
--
-- Adds team_number to court_assignments and availability, supporting the
-- new "partnerships" feature on the printable lineup sheet. team_number
-- identifies which of the two teams (1 or 2) a player is paired into on
-- their court for the first set. Nullable because:
--   - incomplete courts (fewer than 4 players) have no valid pairing
--   - singles courts have no partnerships
--   - historical rows created before this feature existed have no value
--
-- Run this AFTER the existing 000-012 migrations and AFTER
-- 20260531000000_add_court_letter.sql and
-- 20260611120000_add_court_rotations_and_notes.sql.

ALTER TABLE court_assignments ADD COLUMN team_number smallint;
ALTER TABLE availability ADD COLUMN team_number smallint;

ALTER TABLE court_assignments
  ADD CONSTRAINT court_assignments_team_number_valid
  CHECK (team_number IS NULL OR team_number IN (1, 2));

ALTER TABLE availability
  ADD CONSTRAINT availability_team_number_valid
  CHECK (team_number IS NULL OR team_number IN (1, 2));