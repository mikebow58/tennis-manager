-- Migration: add cancellation_reason to availability
-- Date: 2026-09-01
--
-- BUG FIX: The 8pm backstop cron's auto-cancellation of tentative players
-- (court never filled) was writing status = 'cancelled' with no way to
-- distinguish it from a real player self-cancellation or an organiser
-- manual removal. This caused the admin dashboard's cancellation count
-- (app/page.js) to count "court didn't fill" events as cancellations,
-- which they are not.
--
-- cancellation_reason values:
--   'player_initiated'  -- player cancelled themselves post-close
--                           (app/api/cancel/route.js)
--   'admin_cancelled'   -- organiser manually removed a player post-close
--                           (app/api/admin/availability/route.js DELETE)
--   'court_not_filled'  -- tentative players released because their court
--                           never filled -- either the daily-8pm-backstop
--                           cron's auto-cancel step, OR the organiser
--                           manually cancelling an incomplete court from
--                           the court-assignment review screen before 8pm.
--                           Both share this value -- they represent the
--                           same underlying event (court didn't fill),
--                           just triggered automatically vs. manually.
--
-- Column is nullable. NULL means "unknown/legacy" and is treated the same
-- as a real cancellation by the dashboard fix (safe default -- matches
-- pre-fix behaviour for any write path not explicitly updated).

ALTER TABLE availability ADD COLUMN cancellation_reason text;

ALTER TABLE availability ADD CONSTRAINT availability_cancellation_reason_check
  CHECK (cancellation_reason IN ('player_initiated', 'admin_cancelled', 'court_not_filled'));