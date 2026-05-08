-- 011_create_admin_settings.sql
-- Creates the admin_settings table and seeds default values
-- All automation thresholds and configurable settings are stored here
-- Values can be changed by the organiser without a code deployment

CREATE TABLE admin_settings (
    id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    key         text NOT NULL UNIQUE,
    value       text NOT NULL,
    description text
);

-- Index on key -- all queries against this table are key lookups
CREATE INDEX IF NOT EXISTS idx_admin_settings_key ON admin_settings(key);

-- RLS
ALTER TABLE admin_settings ENABLE ROW LEVEL SECURITY;

-- Seed default values
INSERT INTO admin_settings (key, value, description) VALUES
    ('signup_send_day',             'friday',   'Day of week the signup request is automatically sent'),
    ('signup_send_time',            '09:30',    'Time the signup request is automatically sent (HH:MM, 24hr)'),
    ('sub_staleness_hours',         '3',        'Hours after a sub request is sent before it is considered stale'),
    ('first_call_threshold',        '3',        'Consecutive non-responses before a player is culled from First Call list'),
    ('escalation_time',             '17:00',    'Time the escalation notice is sent to organiser if session still short (HH:MM, 24hr)'),
    ('court_assignment_deadline',   '20:00',    'Hard backstop time for court assignment auto-send (HH:MM, 24hr)'),
    ('session_conflict_window_hours', '4',      'Hours within which a player cannot sign up for two sessions on the same day'),
    ('weather_temp_threshold',      '',         'V2+ -- minimum temperature threshold for weather alert (undefined)'),
    ('weather_precip_threshold',    '',         'V2+ -- precipitation threshold for weather alert (undefined)');