// app/api/admin/settings/route.js
//
// GET  /api/admin/settings — returns current values for all organiser-
//      configurable settings: admin email, default session start time,
//      and full location records (name, address, total_courts, notes, active).
//      Used to populate the settings page.
//
// PUT  /api/admin/settings — accepts a partial payload and updates only
//      the fields present. Three independent settings, three different
//      underlying tables (admin_settings, default_sessions, locations),
//      but exposed as a single endpoint since the settings page edits
//      them together. Location edits here are for EXISTING locations only
//      (including deactivate/reactivate via the `active` field) — creating
//      a brand new location is a separate POST (below).
//
// POST /api/admin/settings — creates a new location. Kept on this same route
//      file rather than a new /api/admin/locations route, since this file is
//      already the "organiser settings" endpoint and location creation is a
//      rare, organiser-only action with no other reasonable home.
//
// Auth: this route is NOT added to isPublicRoute in lib/supabase-middleware.js,
// so it is protected by middleware.js by default — only a logged-in organiser
// session can reach it. supabaseAdmin (service role) is used for the actual
// reads/writes, per the standard pattern for API routes.
//
// Tables touched (all via lib/admin-settings.js):
//   admin_settings   — admin_email key
//   default_sessions — start_time, written to all active rows together
//   locations        — name, address, total_courts, notes, active

import {
  getAdminEmail,
  setAdminEmail,
  getDefaultStartTime,
  setDefaultStartTime,
  getLocations,
  createLocation,
  updateLocation,
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
      getLocations(),
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
 *   locations?: Array<{
 *     id: string,
 *     name?: string,
 *     address?: string|null,
 *     totalCourts?: number,
 *     notes?: string|null,
 *     active?: boolean
 *   }>
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
  // Locations — array of partial location updates, written one at a time.
  // Batched in a single request from the UI, but each location is an
  // independent row update — one failure doesn't block the others.
  // This handles routine edits (name, address, total_courts, notes) AND
  // deactivate/reactivate (active: false / true) via the same payload shape.
  // ------------------------------------------------------------------
  if (locations !== undefined) {
    if (!Array.isArray(locations)) {
      console.warn('[admin/settings] PUT — locations field is not an array')
      results.locations = { success: false, error: 'locations must be an array' }
    } else {
      console.log(`[admin/settings] PUT — updating ${locations.length} location(s)`)

      const locationResults = await Promise.all(
        locations.map(async (loc) => {
          if (!loc.id) {
            console.warn('[admin/settings] PUT — skipping location entry with no id:', loc)
            return { id: null, success: false, error: 'Missing location id' }
          }
          // updateLocation does its own field-level validation and only
          // writes fields present in the object — pass through as-is.
          const success = await updateLocation(loc.id, {
            name: loc.name,
            address: loc.address,
            totalCourts: loc.totalCourts,
            notes: loc.notes,
            active: loc.active,
          })
          if (!success) {
            console.error(`[admin/settings] PUT — updateLocation failed for location ${loc.id}`)
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

/**
 * POST /api/admin/settings
 *
 * Creates a new location. This is the only creation action on this route —
 * everything else is a read (GET) or an edit to something that already
 * exists (PUT). Kept separate from PUT rather than overloading it, since
 * "create" and "update many" are different enough operations to warrant
 * their own handler.
 *
 * Expected body shape:
 * {
 *   name: string,
 *   address?: string,
 *   totalCourts: number,
 *   notes?: string
 * }
 *
 * @returns {Promise<Response>} 201 with the new location on success,
 *   400 if required fields are missing/invalid, 500 on database error.
 */
export async function POST(request) {
  console.log('[admin/settings] POST — received create-location request')

  let body
  try {
    body = await request.json()
  } catch {
    console.error('[admin/settings] POST — failed to parse request body')
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { name, address, totalCourts, notes } = body

  const result = await createLocation({ name, address, totalCourts, notes })

  if (!result.success) {
    console.warn('[admin/settings] POST — createLocation rejected:', result.error)
    return Response.json({ error: result.error }, { status: 400 })
  }

  console.log(`[admin/settings] POST — created location ${result.location.id}`)
  return Response.json({ location: result.location }, { status: 201 })
}