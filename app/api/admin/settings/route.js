// app/api/admin/settings/route.js
//
// GET  /api/admin/settings — returns current values for all organiser-
//      configurable settings: admin email, default session start time,
//      and per-location court counts. Used to populate the settings page.
//
// PUT  /api/admin/settings — accepts a partial payload and updates only
//      the fields present. Three independent settings, three different
//      underlying tables (admin_settings, default_sessions, locations),
//      but exposed as a single endpoint since the settings page edits
//      them together.
//
// Auth: this route is NOT added to isPublicRoute in lib/supabase-middleware.js,
// so it is protected by middleware.js by default — only a logged-in organiser
// session can reach it. supabaseAdmin (service role) is used for the actual
// reads/writes, per the standard pattern for API routes.
//
// Tables touched (all via lib/admin-settings.js):
//   admin_settings   — admin_email key
//   default_sessions — start_time, written to all active rows together
//   locations        — total_courts, written per-location

import {
  getAdminEmail,
  setAdminEmail,
  getDefaultStartTime,
  setDefaultStartTime,
  getLocationsWithCourts,
  setLocationCourts,
} from '@/lib/admin-settings'

/**
 * GET /api/admin/settings
 *
 * Reads all three settings in parallel and returns them as a single object.
 * No request body. No params.
 *
 * @returns {Promise<Response>} 200 with { adminEmail, defaultStartTime, locations }
 *   on success, 500 on any read failure.
 */
export async function GET() {
  console.log('[admin/settings] GET — fetching current settings')

  try {
    // Run all three reads in parallel — they touch independent tables and
    // have no ordering dependency on each other.
    const [adminEmail, defaultStartTime, locations] = await Promise.all([
      getAdminEmail(),
      getDefaultStartTime(),
      getLocationsWithCourts(),
    ])

    console.log(
      `[admin/settings] GET — adminEmail=${adminEmail ? 'set' : 'null'} ` +
      `defaultStartTime=${defaultStartTime ?? 'null'} locationsCount=${locations.length}`
    )

    return Response.json({
      adminEmail,
      defaultStartTime,
      locations,
    })
  } catch (err) {
    console.error('[admin/settings] GET — unexpected error:', err)
    return Response.json({ error: 'Failed to load settings' }, { status: 500 })
  }
}

/**
 * PUT /api/admin/settings
 *
 * Accepts a partial payload — only the fields present are updated. Each
 * field maps to one of the three underlying lib/admin-settings.js writers.
 * Fields are processed independently; a failure on one does not block the
 * others, but is reported in the response so the UI can show a precise
 * error rather than a blanket failure.
 *
 * Expected body shape (all fields optional):
 * {
 *   adminEmail?: string,
 *   defaultStartTime?: string,        // e.g. "09:00:00"
 *   locations?: Array<{ id: string, totalCourts: number }>
 * }
 *
 * @returns {Promise<Response>} 200 with per-field success flags on success,
 *   400 if the body is malformed, 500 only if every requested write fails
 *   unexpectedly (individual write failures are reported in the body, not
 *   as a 500 — the UI needs to know exactly which field failed).
 */
export async function PUT(request) {
  console.log('[admin/settings] PUT — received update request')

  let body
  try {
    body = await request.json()
  } catch {
    console.error('[admin/settings] PUT — failed to parse request body')
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { adminEmail, defaultStartTime, locations } = body

  // Track per-field outcomes so the response can tell the UI exactly what
  // succeeded and what didn't, rather than a single pass/fail flag.
  const results = {}

  // ------------------------------------------------------------------
  // Admin email — single value, admin_settings table.
  // ------------------------------------------------------------------
  if (adminEmail !== undefined) {
    console.log('[admin/settings] PUT — updating admin email')

    if (typeof adminEmail !== 'string' || adminEmail.trim().length === 0) {
      console.warn('[admin/settings] PUT — rejected empty/invalid adminEmail')
      results.adminEmail = { success: false, error: 'Admin email cannot be empty' }
    } else {
      const success = await setAdminEmail(adminEmail.trim())
      results.adminEmail = { success }
      if (!success) {
        console.error('[admin/settings] PUT — setAdminEmail failed')
      }
    }
  }

  // ------------------------------------------------------------------
  // Default start time — single value, written across all active
  // default_sessions rows together.
  // ------------------------------------------------------------------
  if (defaultStartTime !== undefined) {
    console.log('[admin/settings] PUT — updating default start time')

    if (typeof defaultStartTime !== 'string' || defaultStartTime.trim().length === 0) {
      console.warn('[admin/settings] PUT — rejected empty/invalid defaultStartTime')
      results.defaultStartTime = { success: false, error: 'Start time cannot be empty' }
    } else {
      const success = await setDefaultStartTime(defaultStartTime.trim())
      results.defaultStartTime = { success }
      if (!success) {
        console.error('[admin/settings] PUT — setDefaultStartTime failed')
      }
    }
  }

  // ------------------------------------------------------------------
  // Locations — array of { id, totalCourts }, written one at a time.
  // Batched in a single request from the UI, but each location is an
  // independent row update — one failure doesn't block the others.
  // ------------------------------------------------------------------
  if (locations !== undefined) {
    if (!Array.isArray(locations)) {
      console.warn('[admin/settings] PUT — locations field is not an array')
      results.locations = { success: false, error: 'locations must be an array' }
    } else {
      console.log(`[admin/settings] PUT — updating ${locations.length} location(s)`)

      const locationResults = await Promise.all(
        locations.map(async (loc) => {
          if (!loc.id || typeof loc.totalCourts !== 'number' || loc.totalCourts < 0) {
            console.warn(`[admin/settings] PUT — skipping invalid location entry:`, loc)
            return { id: loc.id ?? null, success: false, error: 'Invalid location id or totalCourts' }
          }
          const success = await setLocationCourts(loc.id, loc.totalCourts)
          if (!success) {
            console.error(`[admin/settings] PUT — setLocationCourts failed for location ${loc.id}`)
          }
          return { id: loc.id, success }
        })
      )

      const allSucceeded = locationResults.every((r) => r.success)
      results.locations = { success: allSucceeded, results: locationResults }
    }
  }

  console.log('[admin/settings] PUT — complete:', JSON.stringify(results))

  return Response.json({ results })
}