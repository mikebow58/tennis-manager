-- 012_create_notifications.sql
-- Creates the notifications table
-- Stores non-urgent informational events routed to the organiser
-- notification queue on the admin dashboard
-- Immediate/urgent events are handled by direct email, not this table

CREATE TABLE notifications (
    id                  bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    created_at          timestamptz NOT NULL DEFAULT now(),
    type                text NOT NULL,
    message             text NOT NULL,
    player_id           bigint REFERENCES players(id),
    related_record_id   bigint,
    status              text NOT NULL DEFAULT 'unread',
    read_at             timestamptz
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_notifications_status
    ON notifications(status);
CREATE INDEX IF NOT EXISTS idx_notifications_player_id
    ON notifications(player_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at
    ON notifications(created_at DESC);

-- RLS
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;