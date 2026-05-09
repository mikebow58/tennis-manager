-- =============================================================================
-- Migration: RLS Policies for All V2 Tables
-- File: supabase/migrations/20260508120000_rls_policies.sql
-- Applied to: dev database first, then production after verification
--
-- Access model:
--   authenticated  → full read/write (any logged-in organiser account)
--   anon           → no access (safety net against wrong client being used)
--   service_role   → bypasses RLS entirely (all API routes use supabaseAdmin)
--
-- This pattern is identical on every table. Consistency is intentional.
-- If per-organiser access restrictions are ever needed, that is an
-- application-layer concern — not an RLS concern.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- EXISTING V1 TABLES
-- RLS was already enabled on these in V1. These policies replace any prior
-- policies. Verify in Supabase dashboard that no conflicting policies exist
-- before applying.
-- -----------------------------------------------------------------------------

-- players
DROP POLICY IF EXISTS "Authenticated users can read players" ON players;
DROP POLICY IF EXISTS "Authenticated users can write players" ON players;

CREATE POLICY "Authenticated users can read players"
  ON players FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can write players"
  ON players FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- weeks
DROP POLICY IF EXISTS "Authenticated users can read weeks" ON weeks;
DROP POLICY IF EXISTS "Authenticated users can write weeks" ON weeks;

CREATE POLICY "Authenticated users can read weeks"
  ON weeks FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can write weeks"
  ON weeks FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- sessions
DROP POLICY IF EXISTS "Authenticated users can read sessions" ON sessions;
DROP POLICY IF EXISTS "Authenticated users can write sessions" ON sessions;

CREATE POLICY "Authenticated users can read sessions"
  ON sessions FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can write sessions"
  ON sessions FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- availability
DROP POLICY IF EXISTS "Authenticated users can read availability" ON availability;
DROP POLICY IF EXISTS "Authenticated users can write availability" ON availability;

CREATE POLICY "Authenticated users can read availability"
  ON availability FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can write availability"
  ON availability FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);


-- -----------------------------------------------------------------------------
-- NEW V2 TABLES
-- RLS was enabled at creation time with no policies defined. These add the
-- policies. All follow the same authenticated/anon model as the V1 tables.
-- -----------------------------------------------------------------------------

-- locations
DROP POLICY IF EXISTS "Authenticated users can read locations" ON locations;
DROP POLICY IF EXISTS "Authenticated users can write locations" ON locations;

CREATE POLICY "Authenticated users can read locations"
  ON locations FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can write locations"
  ON locations FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- default_sessions
DROP POLICY IF EXISTS "Authenticated users can read default_sessions" ON default_sessions;
DROP POLICY IF EXISTS "Authenticated users can write default_sessions" ON default_sessions;

CREATE POLICY "Authenticated users can read default_sessions"
  ON default_sessions FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can write default_sessions"
  ON default_sessions FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- waitlist
DROP POLICY IF EXISTS "Authenticated users can read waitlist" ON waitlist;
DROP POLICY IF EXISTS "Authenticated users can write waitlist" ON waitlist;

CREATE POLICY "Authenticated users can read waitlist"
  ON waitlist FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can write waitlist"
  ON waitlist FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- sub_requests
DROP POLICY IF EXISTS "Authenticated users can read sub_requests" ON sub_requests;
DROP POLICY IF EXISTS "Authenticated users can write sub_requests" ON sub_requests;

CREATE POLICY "Authenticated users can read sub_requests"
  ON sub_requests FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can write sub_requests"
  ON sub_requests FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- sub_request_recipients
DROP POLICY IF EXISTS "Authenticated users can read sub_request_recipients" ON sub_request_recipients;
DROP POLICY IF EXISTS "Authenticated users can write sub_request_recipients" ON sub_request_recipients;

CREATE POLICY "Authenticated users can read sub_request_recipients"
  ON sub_request_recipients FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can write sub_request_recipients"
  ON sub_request_recipients FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- court_assignments
DROP POLICY IF EXISTS "Authenticated users can read court_assignments" ON court_assignments;
DROP POLICY IF EXISTS "Authenticated users can write court_assignments" ON court_assignments;

CREATE POLICY "Authenticated users can read court_assignments"
  ON court_assignments FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can write court_assignments"
  ON court_assignments FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- groups
DROP POLICY IF EXISTS "Authenticated users can read groups" ON groups;
DROP POLICY IF EXISTS "Authenticated users can write groups" ON groups;

CREATE POLICY "Authenticated users can read groups"
  ON groups FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can write groups"
  ON groups FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- group_members
DROP POLICY IF EXISTS "Authenticated users can read group_members" ON group_members;
DROP POLICY IF EXISTS "Authenticated users can write group_members" ON group_members;

CREATE POLICY "Authenticated users can read group_members"
  ON group_members FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can write group_members"
  ON group_members FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- admin_settings
DROP POLICY IF EXISTS "Authenticated users can read admin_settings" ON admin_settings;
DROP POLICY IF EXISTS "Authenticated users can write admin_settings" ON admin_settings;

CREATE POLICY "Authenticated users can read admin_settings"
  ON admin_settings FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can write admin_settings"
  ON admin_settings FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- notifications
DROP POLICY IF EXISTS "Authenticated users can read notifications" ON notifications;
DROP POLICY IF EXISTS "Authenticated users can write notifications" ON notifications;

CREATE POLICY "Authenticated users can read notifications"
  ON notifications FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can write notifications"
  ON notifications FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);