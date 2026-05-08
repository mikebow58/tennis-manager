-- 006_create_default_sessions.sql
-- Creates the default_sessions table
-- Stores the standard weekly schedule used by monday_week_creation cron
-- to auto-generate sessions each week

CREATE TABLE default_sessions (
    id                  bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    day_of_week         text NOT NULL,
    start_time          time NOT NULL,
    location_id         bigint REFERENCES locations(id),
    courts_available    integer NOT NULL,
    format              text NOT NULL DEFAULT 'paired_rotation',
    notes               text,
    active              boolean NOT NULL DEFAULT true
);

-- Index on active and day_of_week -- used by monday_week_creation cron
-- which queries WHERE active = true for each day
CREATE INDEX IF NOT EXISTS idx_default_sessions_active 
    ON default_sessions(active);
CREATE INDEX IF NOT EXISTS idx_default_sessions_day 
    ON default_sessions(day_of_week);

-- RLS
ALTER TABLE default_sessions ENABLE ROW LEVEL SECURITY;