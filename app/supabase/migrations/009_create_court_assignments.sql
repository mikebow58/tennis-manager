-- 009_create_court_assignments.sql
-- Creates the court_assignments table
-- Stores the output of the court assignment algorithm
-- One record per player per session representing their assigned court and location

CREATE TABLE court_assignments (
    id                  bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    session_id          bigint NOT NULL REFERENCES sessions(id),
    player_id           bigint NOT NULL REFERENCES players(id),
    location_id         bigint REFERENCES locations(id),
    court_number        integer NOT NULL,
    assignment_status   text NOT NULL DEFAULT 'confirmed'
);

-- Unique constraint -- one assignment per player per session
ALTER TABLE court_assignments ADD CONSTRAINT uq_court_assignments_player_session
    UNIQUE (player_id, session_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_court_assignments_session_id
    ON court_assignments(session_id);
CREATE INDEX IF NOT EXISTS idx_court_assignments_player_id
    ON court_assignments(player_id);
CREATE INDEX IF NOT EXISTS idx_court_assignments_status
    ON court_assignments(assignment_status);

-- RLS
ALTER TABLE court_assignments ENABLE ROW LEVEL SECURITY;