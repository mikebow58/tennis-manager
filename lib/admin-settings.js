// lib/admin-settings.js
// Shared utility for reading and writing organiser-configurable settings
// that previously required direct database or environment variable access.
// Backs the admin settings page (app/admin/settings/page.js) and replaces
// process.env.ADMIN_EMAIL across all cron and API route call sites.
//
// Three underlying tables are involved, even though this is conceptually
// "one settings page" to the organiser:
//   - admin_settings   (key-value store) -> admin_email
//   - default_sessions (one row per active day) -> start_time
//   - locations        (one row per location) -> total_courts
//
// All functions use supabaseAdmin (service role) since this file is called
// from both API routes and crons, neither of which has a user session.

import { supabaseAdmin } from './supabase-admin'

// ---------------------------------------------------------------------------
// ADMIN EMAIL — admin_settings.admin_email
// ---------------------------------------------------------------------------

/**
 * Reads the organiser's admin email recipient(s) from admin_settings.
 * Replaces process.env.ADMIN_EMAIL across all call sites. Supports the same
 * comma-separated multi-recipient format the env var previously supported.
 *
 * No environment variable fallback: the admin_settings row is the single
 * source of truth from the migration date forward (pre-production, so a
 * hard cutover is safe — no dual-path logic to remove later).
 *
 * @returns {Promise<string|null>} Comma-separated email string, or null if
 *   the key is missing or empty (callers must null-check, same as the
 *   existing `if (!adminEmail)` pattern used at every current call site).
 */
export async function getAdminEmail() {
  const { data, error } = await supabaseAdmin
    .from('admin_settings')
    .select('value')
    .eq('key', 'admin_email')
    .single()

  if (error) {
    // Row missing or query failed — treat identically to "not configured".
    // Callers already handle null adminEmail with their own guard clause.
    console.error('getAdminEmail error:', error)
    return null
  }

  // Empty string is treated the same as missing — avoids sending to "".
  return data?.value || null
}

/**
 * Upserts the organiser's admin email recipient(s) into admin_settings.
 * Used by the settings page API route (PUT /api/admin/settings).
 *
 * @param {string} value - Comma-separated email address(es).
 * @returns {Promise<boolean>} true on success, false on error.
 */
export async function setAdminEmail(value) {
  const { error } = await supabaseAdmin
    .from('admin_settings')
    .upsert({ key: 'admin_email', value }, { onConflict: 'key' })

  if (error) {
    console.error('setAdminEmail error:', error)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// DEFAULT SESSION START TIME — default_sessions.start_time
// ---------------------------------------------------------------------------

/**
 * Reads the default session start time. There is no single source-of-truth
 * row for this value — it's stored per-row on default_sessions (one row per
 * active day of week) because that's where the schema puts it. In practice
 * all active rows should hold the same value, since setDefaultStartTime()
 * always writes to all of them together.
 *
 * Disagreement rule: returns the first active row's value (ordered by
 * day_of_week for determinism) and logs a warning if any other active row
 * disagrees. This is self-healing — the next time the organiser saves a new
 * default time via the settings page, all rows are overwritten and brought
 * back into agreement.
 *
 * @returns {Promise<string|null>} Time string (e.g. "09:00:00"), or null if
 *   no active default_sessions rows exist.
 */
export async function getDefaultStartTime() {
  const { data, error } = await supabaseAdmin
    .from('default_sessions')
    .select('day_of_week, start_time')
    .eq('active', true)
    .order('day_of_week', { ascending: true })

  if (error) {
    console.error('getDefaultStartTime error:', error)
    return null
  }

  if (!data || data.length === 0) {
    return null
  }

  const canonicalTime = data[0].start_time

  // Flag drift rather than silently picking a majority value — drift should
  // only happen from manual DB edits or a partial write failure, and the
  // organiser should know about it even though the fix is just "save again".
  const disagreeing = data.filter((row) => row.start_time !== canonicalTime)
  if (disagreeing.length > 0) {
    console.warn(
      `getDefaultStartTime: ${disagreeing.length} default_sessions row(s) disagree with ` +
      `the canonical value (${canonicalTime}). Returning the first active row's value. ` +
      `Re-saving the settings page will resync all rows.`
    )
  }

  return canonicalTime
}

/**
 * Writes a new default start time across all active default_sessions rows.
 * Used by the settings page API route. This is a single conceptual value to
 * the organiser even though the schema stores it per-row — so a save here
 * always updates every active row together, keeping them in agreement.
 *
 * @param {string} value - Time string (e.g. "09:00:00").
 * @returns {Promise<boolean>} true on success, false on error.
 */
export async function setDefaultStartTime(value) {
  const { error } = await supabaseAdmin
    .from('default_sessions')
    .update({ start_time: value })
    .eq('active', true)

  if (error) {
    console.error('setDefaultStartTime error:', error)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// LOCATION COURT COUNTS — locations.total_courts
// ---------------------------------------------------------------------------

/**
 * Reads all locations with their current total_courts value, for display on
 * the settings page. Location name is included for display context but is
 * not editable from this page (renaming a location is treated as a separate,
 * rarer operation).
 *
 * @returns {Promise<Array<{id: string, name: string, total_courts: number}>>}
 *   Empty array on error or if no locations exist.
 */
export async function getLocationsWithCourts() {
  const { data, error } = await supabaseAdmin
    .from('locations')
    .select('id, name, total_courts')
    .order('name', { ascending: true })

  if (error) {
    console.error('getLocationsWithCourts error:', error)
    return []
  }

  return data || []
}

/**
 * Updates total_courts for a single location. Used by the settings page API
 * route — each location's court count is saved independently, not as a
 * single batched value like the start time.
 *
 * @param {string} locationId - UUID of the location row.
 * @param {number} totalCourts
 * @returns {Promise<boolean>} true on success, false on error.
 */
export async function setLocationCourts(locationId, totalCourts) {
  const { error } = await supabaseAdmin
    .from('locations')
    .update({ total_courts: totalCourts })
    .eq('id', locationId)

  if (error) {
    console.error('setLocationCourts error:', error)
    return false
  }
  return true
}