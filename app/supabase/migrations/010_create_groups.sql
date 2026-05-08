-- 010_create_groups.sql
-- Creates the groups and group_members tables
-- groups defines named sub-groups of players associated with specific session types
-- group_members tracks which players belong to each group

CREATE TABLE groups (
    id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    name        text NOT NULL,
    description text,
    match_type  text NOT NULL,
    active      boolean NOT NULL DEFAULT true
);

-- Index on active status
CREATE INDEX IF NOT EXISTS idx_groups_active ON groups(active);

-- RLS
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;

-- Now that groups table exists, add foreign key constraint to sessions
ALTER TABLE sessions ADD CONSTRAINT fk_sessions_group
    FOREIGN KEY (group_id) REFERENCES groups(id);

-- group_members
CREATE TABLE group_members (
    id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    created_at  timestamptz NOT NULL DEFAULT now(),
    group_id    bigint NOT NULL REFERENCES groups(id),
    player_id   bigint NOT NULL REFERENCES players(id),
    added_at    timestamptz NOT NULL DEFAULT now(),
    added_by    text,
    active      boolean NOT NULL DEFAULT true
);

-- Unique constraint -- one membership record per player per group
ALTER TABLE group_members ADD CONSTRAINT uq_group_members_player_group
    UNIQUE (player_id, group_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_group_members_group_id
    ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_player_id
    ON group_members(player_id);
CREATE INDEX IF NOT EXISTS idx_group_members_active
    ON group_members(active);

-- RLS
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;