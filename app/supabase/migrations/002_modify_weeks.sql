-- 002_modify_weeks.sql
-- Modifies the weeks table for V2

-- 1. Rename start_date to week_start_date to match V2 naming convention
ALTER TABLE weeks RENAME COLUMN start_date TO week_start_date;

-- 2. Update status default from 'open' to 'pending_approval'
ALTER TABLE weeks ALTER COLUMN status SET DEFAULT 'pending_approval';

-- 3. Add new V2 fields
ALTER TABLE weeks ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE weeks ADD COLUMN IF NOT EXISTS closed_at timestamptz;