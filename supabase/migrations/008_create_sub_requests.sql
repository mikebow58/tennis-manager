-- 008_create_sub_requests.sql
-- Creates the sub_requests and sub_request_recipients tables
-- sub_requests tracks each broadcast sent seeking a fill-in or replacement player
-- sub_request_recipients tracks which players were contacted in each broadcast

CREATE TABLE sub_requests (
    id                  bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    created_at          timestamptz NOT NULL DEFAULT now(),
    session_id          bigint NOT NULL REFERENCES sessions(id),
    sent_at             timestamptz NOT NULL DEFAULT now(),
    request_type        text NOT NULL,
    status              text NOT NULL DEFAULT 'active',
    filled_at           timestamptz,
    filled_by_player_id bigint REFERENCES players(id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sub_requests_session_id 
    ON sub_requests(session_id);
CREATE INDEX IF NOT EXISTS idx_sub_requests_status 
    ON sub_requests(status);
CREATE INDEX IF NOT EXISTS idx_sub_requests_sent_at 
    ON sub_requests(sent_at);

-- RLS
ALTER TABLE sub_requests ENABLE ROW LEVEL SECURITY;

-- sub_request_recipients
CREATE TABLE sub_request_recipients (
    id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    created_at      timestamptz NOT NULL DEFAULT now(),
    sub_request_id  bigint NOT NULL REFERENCES sub_requests(id),
    player_id       bigint NOT NULL REFERENCES players(id),
    sent_at         timestamptz NOT NULL DEFAULT now(),
    response        text,
    responded_at    timestamptz
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sub_request_recipients_sub_request_id 
    ON sub_request_recipients(sub_request_id);
CREATE INDEX IF NOT EXISTS idx_sub_request_recipients_player_id 
    ON sub_request_recipients(player_id);

-- RLS
ALTER TABLE sub_request_recipients ENABLE ROW LEVEL SECURITY;