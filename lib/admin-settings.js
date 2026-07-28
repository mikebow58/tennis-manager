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
//   - locations        (one row per location) -> name, address, total_courts,
//                                                  notes, active
//
// All functions use supabaseAdmin (service role) since this file is called
// from both API routes and crons, neither of which has a user session.
//
// THIS REVISION: location functions expanded from courts-only editing to full
// CRUD (name, address, notes, active-toggle-as-soft-delete, and creation) —
// previously the organiser had no way to add a location, edit its name/address,
// or deactivate one without direct SQL access.

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
// LOCATIONS — locations table, full CRUD
// ---------------------------------------------------------------------------

/**
 * Reads all locations (active AND inactive) with their full editable fields,
 * for display on the settings page. Inactive locations are included so the
 * organiser can reactivate one if needed — they're just excluded from
 * elsewhere-in-the-app dropdowns (session creation, etc.) by those callers'
 * own `active = true` filters, not by this function.
 *
 * Ordered active-first, then alphabetically, so the organiser sees live
 * locations before deactivated ones.
 *
 * @returns {Promise<Array<{
 *   id: string, name: string, address: string|null,
 *   total_courts: number, notes: string|null, active: boolean
 * }>>} Empty array on error or if no locations exist.
 */
export async function getLocations() {
  const { data, error } = await supabaseAdmin
    .from('locations')
    .select('id, name, address, total_courts, notes, active')
    .order('active', { ascending: false })
    .order('name', { ascending: true })

  if (error) {
    console.error('getLocations error:', error)
    return []
  }

  return data || []
}

/**
 * Creates a new location. Used by the settings page's "Add location" form.
 * New locations are created active by default.
 *
 * @param {object} params
 * @param {string} params.name
 * @param {string|null} [params.address]
 * @param {number} params.totalCourts
 * @param {string|null} [params.notes]
 * @returns {Promise<{success: boolean, location?: object, error?: string}>}
 */
export async function createLocation({ name, address, totalCourts, notes }) {
  // Basic validation up front — the API route also validates, but this
  // function is the single source of truth for "what makes a valid location"
  // so it re-checks rather than trusting the caller.
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return { success: false, error: 'Location name is required' }
  }
  if (typeof totalCourts !== 'number' || isNaN(totalCourts) || totalCourts < 0) {
    return { success: false, error: 'Total courts must be a non-negative number' }
  }

  const { data, error } = await supabaseAdmin
    .from('locations')
    .insert({
      name: name.trim(),
      address: address?.trim() || null,
      total_courts: totalCourts,
      notes: notes?.trim() || null,
      active: true,
    })
    .select('id, name, address, total_courts, notes, active')
    .single()

  if (error) {
    console.error('createLocation error:', error)
    return { success: false, error: 'Database error creating location' }
  }

  return { success: true, location: data }
}

/**
 * Updates an existing location's editable fields. Any field omitted from
 * `updates` is left unchanged — this is a partial update, not a full replace.
 *
 * Used both for routine edits (name, address, total_courts, notes) and for
 * deactivation/reactivation (active: false / true), which the settings page
 * treats as "delete" / "restore" — a hard DB delete is intentionally not
 * offered, consistent with the soft-delete pattern used everywhere else in
 * this app (players.active, etc.).
 *
 * @param {string} locationId - UUID of the location row.
 * @param {object} updates - Partial fields to update.
 * @param {string} [updates.name]
 * @param {string|null} [updates.address]
 * @param {number} [updates.totalCourts]
 * @param {string|null} [updates.notes]
 * @param {boolean} [updates.active]
 * @returns {Promise<boolean>} true on success, false on error.
 */
export async function updateLocation(locationId, updates) {
  const payload = {}

  if (updates.name !== undefined) {
    if (typeof updates.name !== 'string' || updates.name.trim().length === 0) {
      console.error(`updateLocation error: rejected empty name for location ${locationId}`)
      return false
    }
    payload.name = updates.name.trim()
  }
  if (updates.address !== undefined) {
    payload.address = updates.address?.trim() || null
  }
  if (updates.totalCourts !== undefined) {
    if (typeof updates.totalCourts !== 'number' || isNaN(updates.totalCourts) || updates.totalCourts < 0) {
      console.error(`updateLocation error: rejected invalid totalCourts for location ${locationId}`)
      return false
    }
    payload.total_courts = updates.totalCourts
  }
  if (updates.notes !== undefined) {
    payload.notes = updates.notes?.trim() || null
  }
  if (updates.active !== undefined) {
    payload.active = Boolean(updates.active)
  }

  // Nothing valid to write — treat as a no-op success rather than an error.
  if (Object.keys(payload).length === 0) {
    return true
  }

  const { error } = await supabaseAdmin
    .from('locations')
    .update(payload)
    .eq('id', locationId)

  if (error) {
    console.error(`updateLocation error for location ${locationId}:`, error)
    return false
  }
  return true
}