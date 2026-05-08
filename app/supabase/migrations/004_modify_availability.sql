-- 004_modify_availability.sql
-- Modifies the availability table for V2

-- 1. Add new V2 fields
ALTER TABLE availability ADD COLUMN IF NOT EXISTS court_assignment_status text;
ALTER TABLE availability ADD COLUMN IF NOT EXISTS location_id bigint;
ALTER TABLE availability ADD COLUMN IF NOT EXISTS court_number integer;
ALTER TABLE availability ADD COLUMN IF NOT EXISTS organiser_added boolean NOT NULL DEFAULT false;

-- 2. Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_availability_session_id ON availability(session_id);
CREATE INDEX IF NOT EXISTS idx_availability_player_id ON availability(player_id);
CREATE INDEX IF NOT EXISTS idx_availability_status ON availability(status);