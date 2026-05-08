-- 003_modify_sessions.sql
-- Modifies the sessions table for V2

-- 1. Rename court_count to courts_available to match V2 naming convention
ALTER TABLE sessions RENAME COLUMN court_count TO courts_available;

-- 2. Add new V2 fields
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS location_id bigint;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS anticipated_courts integer;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS match_type text DEFAULT 'doubles';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS group_id bigint;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reinstated_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS court_assignment_notified_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS court_assignment_approved_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS court_assignment_sent_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS organiser_notes text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cancellation_note text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS organiser_added boolean NOT NULL DEFAULT false;

-- 3. Add index on week_id for performance
CREATE INDEX IF NOT EXISTS idx_sessions_week_id ON sessions(week_id);