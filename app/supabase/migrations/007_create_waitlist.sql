-- 007_create_waitlist.sql
-- Creates the waitlist table
-- Tracks players queued for a spot on a session that has reached full status

CREATE TABLE waitlist (
    id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    created_at      timestamptz NOT NULL DEFAULT now(),
    session_id      bigint NOT NULL REFERENCES sessions(id),
    player_id       bigint NOT NULL REFERENCES players(id),
    entry_type      text NOT NULL,
    status          text NOT NULL DEFAULT 'waiting',
    responded_at    timestamptz,
    response        text
);

-- Index on session_id -- heavily used by waitlist promotion logic
CREATE INDEX IF NOT EXISTS idx_waitlist_session_id ON waitlist(session_id);

-- Index on player_id -- used to check if a player is already waitlisted
CREATE INDEX IF NOT EXISTS idx_waitlist_player_id ON waitlist(player_id);

-- Index on status -- used to filter active waiting records
CREATE INDEX IF NOT EXISTS idx_waitlist_status ON waitlist(status);

-- RLS
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;