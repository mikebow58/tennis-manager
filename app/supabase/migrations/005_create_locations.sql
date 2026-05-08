-- 005_create_locations.sql
-- Creates the locations master record table

CREATE TABLE locations (
    id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    name            text NOT NULL,
    address         text,
    total_courts    integer,
    active          boolean NOT NULL DEFAULT true,
    notes           text
);

-- Now that locations table exists, add foreign key constraint to sessions
ALTER TABLE sessions ADD CONSTRAINT fk_sessions_location
    FOREIGN KEY (location_id) REFERENCES locations(id);

-- And to availability
ALTER TABLE availability ADD CONSTRAINT fk_availability_location
    FOREIGN KEY (location_id) REFERENCES locations(id);

-- Index on active status for dropdown queries
CREATE INDEX IF NOT EXISTS idx_locations_active ON locations(active);

-- RLS
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;