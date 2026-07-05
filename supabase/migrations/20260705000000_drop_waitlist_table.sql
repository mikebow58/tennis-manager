-- Drops the waitlist table. Superseded by the availability.status = 'waitlisted'
-- model formalized in Phase 2 (Section 7.1/7.2) and Phase 3 (Group 3) of the
-- automated workflow spec. This table was part of an earlier design iteration
-- and was never wired into any application code — confirmed empty before drop.
--
-- Safety review:
--   Touches existing rows? No — table confirmed empty.
--   Could it fail partway through? No — single DROP TABLE, no data migration.
--   Rollback plan: none needed; table can be recreated from 007_create_waitlist.sql
--   if this decision is ever reversed.

DROP TABLE IF EXISTS waitlist;