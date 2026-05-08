-- 001_modify_players.sql
-- Modifies the players table for V2
-- Run against dev first, then production at cutover

-- 1. Rename existing fields to match V2 naming
ALTER TABLE players RENAME COLUMN typical_days TO typical_play_days;
ALTER TABLE players RENAME COLUMN mobile TO mobile_number;

-- 2. Migrate skill columns from numeric to integer
ALTER TABLE players ALTER COLUMN skill_self TYPE integer USING round(skill_self)::integer;
ALTER TABLE players ALTER COLUMN skill_admin TYPE integer USING round(skill_admin)::integer;

-- 3. Add new V2 fields
ALTER TABLE players ADD COLUMN IF NOT EXISTS first_call boolean NOT NULL DEFAULT false;
ALTER TABLE players ADD COLUMN IF NOT EXISTS unavailable_days text[] DEFAULT '{}';
ALTER TABLE players ADD COLUMN IF NOT EXISTS match_type_preferences text[] DEFAULT '{}';

-- 4. Drop fields superseded by V2
ALTER TABLE players DROP COLUMN IF EXISTS mixed_doubles;
ALTER TABLE players DROP COLUMN IF EXISTS player_type;

-- 5. Add index on signup_token for performance (used on every player-facing page load)
CREATE INDEX IF NOT EXISTS idx_players_signup_token ON players(signup_token);