-- 000_base_schema.sql
-- Recreates the current production schema exactly as it exists prior to V2 migrations.
-- This file establishes the baseline. All V2 changes are applied by subsequent migrations.
-- Run this first on any fresh database before running 001 and above.

-- players
CREATE TABLE players (
    id                  bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    created_at          timestamptz NOT NULL DEFAULT now(),
    first_name          text,
    last_name           text,
    mobile              text,
    email               text,
    gender              text,
    skill_self          numeric,
    skill_admin         numeric,
    mixed_doubles       boolean NOT NULL DEFAULT true,
    typical_days        text[],
    player_type         text DEFAULT 'regular',
    active              boolean DEFAULT true,
    notes               text,
    signup_token        text
);

-- weeks
CREATE TABLE weeks (
    id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    created_at      timestamptz NOT NULL DEFAULT now(),
    start_date      date,
    status          text DEFAULT 'open',
    signup_sent_at  timestamptz
);

-- sessions
CREATE TABLE sessions (
    id                bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    created_at        timestamptz NOT NULL DEFAULT now(),
    week_id           bigint,
    session_date      date,
    start_time        time,
    location          text,
    court_count       smallint,
    format            text DEFAULT 'paired_rotation',
    status            text DEFAULT 'open',
    notes             text,
    reminder_sent_at  timestamptz
);

-- availability
CREATE TABLE availability (
    id            bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    created_at    timestamptz NOT NULL DEFAULT now(),
    session_id    bigint,
    player_id     bigint,
    status        text DEFAULT 'confirmed',
    cancelled_at  timestamptz
);

-- Foreign key constraints
ALTER TABLE sessions ADD CONSTRAINT fk_sessions_week
    FOREIGN KEY (week_id) REFERENCES weeks(id);

ALTER TABLE availability ADD CONSTRAINT fk_availability_session
    FOREIGN KEY (session_id) REFERENCES sessions(id);

ALTER TABLE availability ADD CONSTRAINT fk_availability_player
    FOREIGN KEY (player_id) REFERENCES players(id);

-- RLS: enable on all tables
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE weeks ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability ENABLE ROW LEVEL SECURITY;