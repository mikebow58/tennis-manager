/**
 * daily-8am — Vercel Cron Job
 *
 * Scheduled: 08:00 MDT daily (14:00 UTC, "0 14 * * *" in vercel.json).
 * Note: will drift 1 hour early in MST (November–March). See project
 * decisions log — accepted for now, revisit before first winter season.
 *
 * Three independent checks run every day. All three always run regardless
 * of the outcome of the others. Any combination may produce emissions.
 *
 * CHECK A — Pre-close fill-in (Wed–Sat only): DEFERRED. Not yet built.
 *   Will fire targeted fill-in requests for short sessions scheduled
 *   for tomorrow. Requires First Call list and skill targeting logic.
 *
 * CHECK B — Reminder sends:
 *   Finds sessions whose reminder is due today (per day-of-week timing
 *   rules), runs Procedure 1 (initial court balancing) on each, sends
 *   tiered reminder emails (confirmed or tentative), and closes the session.
 *
 * CHECK C — Week close:
 *   Finds weeks in 'sent' status where all child sessions have passed
 *   their start time and transitions them to 'closed'.
 *
 * Tables read:  weeks, sessions, availability, players, locations
 * Tables written: sessions (status, reminder_sent_at),
 *                 availability (status, court_assignment_status),
 *                 weeks (status, closed_at)
 *
 * Emails sent:
 *   - Confirmed players: sendConfirmedReminderBatch (Check B)
 *   - Tentative players: sendTentativeReminderBatch (Check B)
 *
 * References:
 *   Phase 1 Cron Map — Section 4.5 (Check B) and Section 4.5 (Check C)
 *   Phase 2 State Machines — Section 4.4 (Procedure 1), Section 4.2
 *   Automation Logic — Section 2.1 (tiered reminder system)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  sendConfirmedReminderBatch,
  sendTentativeReminderBatch,
} from '@/lib/email'
import { runProcedure1, resolveSkill, SKILL_SELF_TO_ADMIN } from '@/lib/court-balancing'

export async function GET(request) {
  // Record entry time so execution duration is calculable from logs.
  const startTime = Date.now()
  console.log('[daily-8am] Cron fired at', new Date().toISOString())

  // ------------------------------------------------------------------
  // Guard: verify request is from Vercel's cron scheduler.
  // Vercel sets Authorization: Bearer <CRON_SECRET> on cron requests.
  // ------------------------------------------------------------------
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[daily-8am] Unauthorised request — missing or invalid CRON_SECRET')
    return new Response('Unauthorised', { status: 401 })
  }

  // ------------------------------------------------------------------
  // Shared: establish today's date in America/Denver timezone.
  // All session dates are stored as date-only strings ('YYYY-MM-DD').
  // We need today and tomorrow as date strings for session queries.
  // Using Intl.DateTimeFormat to get the correct local date regardless
  // of server timezone (Vercel runs in UTC).
  // ------------------------------------------------------------------
  const nowUtc = new Date()

  // Format a Date object as 'YYYY-MM-DD' in Mountain Time.
  function toMountainDateStr(date) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Denver',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  }

  const todayStr = toMountainDateStr(nowUtc)

  // Tomorrow's date — used by Check B reminder timing logic.
  const tomorrowDate = new Date(nowUtc)
  tomorrowDate.setUTCDate(nowUtc.getUTCDate() + 1)
  const tomorrowStr = toMountainDateStr(tomorrowDate)

  console.log('[daily-8am] Today (MT):', todayStr, '| Tomorrow (MT):', tomorrowStr)

  // Collect outcome summaries from each check for the final response.
  const outcomes = { checkA: 'deferred', checkB: null, checkC: null }

  // ==================================================================
  // CHECK A — Pre-close fill-in (DEFERRED)
  // Requires First Call list and skill level targeting — not yet built.
  // ==================================================================
  console.log('[daily-8am] Check A: deferred — skipping.')

  // ==================================================================
  // CHECK B — Reminder sends
  //
  // Decision tree (Phase 1 Section 4.5 Check B):
  //   1. Query sessions WHERE status = 'open' AND reminder_sent_at IS NULL
  //      AND cancelled_at IS NULL.
  //   2. For each: apply timing rule to determine if reminder is due today.
  //      Monday session    → remind Sunday   (session_date - 1 day)
  //      Tuesday session   → remind Monday   (session_date - 1 day)
  //      Wed–Sat session   → remind 2 days prior (session_date - 2 days)
  //   3. If due: run Procedure 1 (initial court balancing).
  //   4. Send tiered reminders (confirmed or tentative).
  //   5. UPDATE sessions SET status = 'closed', reminder_sent_at = now().
  // ==================================================================
  console.log('[daily-8am] Check B: starting reminder send check.')

  try {
    // Fetch all open, un-reminded, non-cancelled sessions across all
    // weeks currently in 'sent' status. Include location join for the
    // confirmed reminder email and availability for Procedure 1.
    // We fetch availability and players separately per session below
    // to keep queries manageable and logging granular.
    const { data: openSessions, error: sessionsError } = await supabaseAdmin
      .from('sessions')
      .select(`
        id,
        session_date,
        start_time,
        courts_available,
        notes,
        week_id,
        locations ( id, name ),
        weeks!inner ( status )
      `)
      .eq('status', 'open')
      .is('reminder_sent_at', null)
      .is('cancelled_at', null)
      .eq('weeks.status', 'sent')

    if (sessionsError) {
      console.error('[daily-8am] Check B: error querying sessions:', sessionsError.message)
      outcomes.checkB = 'error'
    } else {
      console.log(`[daily-8am] Check B: found ${openSessions.length} open session(s) to evaluate.`)

      // Track totals across all sessions for the final log summary.
      let sessionsReminded = 0
      let totalConfirmed = 0
      let totalTentative = 0

      for (const session of openSessions) {
        // ----------------------------------------------------------------
        // Step 1: Determine if reminder is due today for this session.
        // Parse session_date and compute the date the reminder should fire.
        // ----------------------------------------------------------------
        const sessionDate = new Date(session.session_date + 'T12:00:00Z')
        const dayOfWeek = sessionDate.getUTCDay()
        // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat

        // Days prior to session that the reminder fires:
        // Monday (1) and Tuesday (2): 1 day prior.
        // Wednesday (3) through Saturday (6): 2 days prior.
        const daysPrior = dayOfWeek <= 2 ? 1 : 2

        const reminderDate = new Date(sessionDate)
        reminderDate.setUTCDate(sessionDate.getUTCDate() - daysPrior)
        const reminderDateStr = toMountainDateStr(reminderDate)

        if (reminderDateStr !== todayStr) {
          // Reminder not due today — skip this session. Expected on
          // Friday and Saturday mornings when no reminder is due.
          console.log(
            `[daily-8am] Check B: session ${session.id} (${session.session_date}) ` +
            `dayOfWeek=${dayOfWeek} daysPrior=${daysPrior} reminderDue=${reminderDateStr} today=${todayStr} — skipping.`
          )
          continue
        }

        console.log(
          `[daily-8am] Check B: session ${session.id} (${session.session_date}) ` +
          `reminder due today — proceeding with Procedure 1.`
        )

        // ----------------------------------------------------------------
        // Step 2: Fetch all signed-up players for this session.
        // All players are currently in 'confirmed' status at this point —
        // 'tentative' is a Procedure 1 output, not set at signup time.
        // We need skill_admin (primary) and skill_self (fallback) for
        // the balancing algorithm, plus availability.created_at for FIFO.
        // ----------------------------------------------------------------
        const { data: availability, error: availError } = await supabaseAdmin
          .from('availability')
          .select(`
            id,
            player_id,
            created_at,
            players (
              id,
              first_name,
              email,
              skill_admin,
              skill_self,
              signup_token
            )
          `)
          .eq('session_id', session.id)
          .eq('status', 'confirmed')
          .order('created_at', { ascending: true }) // FIFO order preserved for tiebreaker

        if (availError) {
          console.error(
            `[daily-8am] Check B: error fetching availability for session ${session.id}:`,
            availError.message
          )
          continue
        }

        const playerCount = availability.length
        console.log(
          `[daily-8am] Check B: session ${session.id} has ${playerCount} signed-up player(s).`
        )

        if (playerCount === 0) {
          // No players signed up — close the session without sending any
          // reminders. Sub request logic is not triggered here (no one
          // was ever confirmed). Log and close.
          console.log(
            `[daily-8am] Check B: session ${session.id} has 0 players — closing with no reminders.`
          )
          await supabaseAdmin
            .from('sessions')
            .update({ status: 'closed', reminder_sent_at: new Date().toISOString() })
            .eq('id', session.id)
          sessionsReminded++
          continue
        }

        // ----------------------------------------------------------------
        // Step 3: Resolve each player's effective skill level.
        // Skill resolution delegated to lib/court-balancing.js.
        // ----------------------------------------------------------------
        const players = availability.map((avail) => ({
          availabilityId: avail.id,
          playerId: avail.player_id,
          firstName: avail.players.first_name,
          email: avail.players.email,
          signupToken: avail.players.signup_token,
          createdAt: avail.created_at,
          skill: resolveSkill(avail.players),
        }))

        // ----------------------------------------------------------------
        // Step 4: Run Procedure 1 — Initial Court Balancing.
        // Full algorithm in lib/court-balancing.js.
        // ----------------------------------------------------------------
        const { confirmedIds: confirmedPlayerIds, tentativeCount, bestScore, courtsCount } =
          runProcedure1(players)

        console.log(
          `[daily-8am] Check B: Procedure 1 — ${playerCount} players, ` +
          `${courtsCount} full court(s), ${tentativeCount} tentative. ` +
          `bestScore=${bestScore}`
        )

        // ----------------------------------------------------------------
        // Step 5: Write Procedure 1 results to the availability table.
        // Players in confirmedPlayerIds stay confirmed.
        // All others transition to tentative.
        // court_assignment_status mirrors availability.status at this stage.
        // ----------------------------------------------------------------
        const confirmedAvailIds = players
          .filter((p) => confirmedPlayerIds.has(p.availabilityId))
          .map((p) => p.availabilityId)

        const tentativeAvailIds = players
          .filter((p) => !confirmedPlayerIds.has(p.availabilityId))
          .map((p) => p.availabilityId)

        // Write tentative status for incomplete-court players.
        if (tentativeAvailIds.length > 0) {
          const { error: tentativeError } = await supabaseAdmin
            .from('availability')
            .update({
              status: 'tentative',
              court_assignment_status: 'tentative',
            })
            .in('id', tentativeAvailIds)

          if (tentativeError) {
            console.error(
              `[daily-8am] Check B: error writing tentative status for session ${session.id}:`,
              tentativeError.message
            )
            // Do not continue — if we can't write status we shouldn't send
            // reminders, as players would receive the wrong message tier.
            continue
          }
          console.log(
            `[daily-8am] Check B: session ${session.id} — ${tentativeAvailIds.length} player(s) set to tentative.`
          )
        }

        // Confirmed players: court_assignment_status set to 'confirmed'.
        // availability.status is already 'confirmed' from signup — only
        // court_assignment_status needs to be set here.
        if (confirmedAvailIds.length > 0) {
          const { error: confirmedError } = await supabaseAdmin
            .from('availability')
            .update({ court_assignment_status: 'confirmed' })
            .in('id', confirmedAvailIds)

          if (confirmedError) {
            console.error(
              `[daily-8am] Check B: error writing confirmed court_assignment_status for session ${session.id}:`,
              confirmedError.message
            )
            continue
          }
        }

        // ----------------------------------------------------------------
        // Step 6: Build and send tiered reminder emails.
        //
        // Confirmed players: full session details (time, location, notes).
        // Tentative players: status-only message with 8pm deadline.
        //
        // deadlineLabel for tentative emails: "tonight" if session is
        // tomorrow, otherwise "the evening before [day name]".
        // ----------------------------------------------------------------
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL

        // Format session date for email subjects: "Monday, May 19"
        const sessionDateLabel = sessionDate.toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          timeZone: 'UTC',
        })

        // Format start time for confirmed reminder: "9:00 AM"
        const startTimeLabel = session.start_time
          ? new Date(`1970-01-01T${session.start_time}Z`).toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
              timeZone: 'UTC',
            })
          : 'TBD'

        // Location name from the join. Falls back to 'TBD' if not set.
        const locationName = session.locations?.name ?? 'TBD'

        // Deadline label for tentative emails. Session is either tomorrow
        // (reminder fires 1 day prior for Mon/Tue) or the day after tomorrow
        // (reminder fires 2 days prior for Wed–Sat). In both cases the
        // 8pm deadline is the evening before the session.
        const sessionDayName = sessionDate.toLocaleDateString('en-US', {
          weekday: 'long',
          timeZone: 'UTC',
        })
        // Compute the day before the session for the deadline label.
        const deadlineDate = new Date(sessionDate)
        deadlineDate.setUTCDate(sessionDate.getUTCDate() - 1)
        const deadlineDayName = deadlineDate.toLocaleDateString('en-US', {
          weekday: 'long',
          timeZone: 'UTC',
        })
        // If the deadline day is tomorrow (from today's perspective), say
        // "tomorrow evening". Otherwise say "Monday evening" etc.
        const deadlineTomorrowStr = toMountainDateStr(tomorrowDate)
        const deadlineDateStr = toMountainDateStr(deadlineDate)
        const deadlineLabel = deadlineDateStr === deadlineTomorrowStr
          ? 'tomorrow evening'
          : `${deadlineDayName} evening`

        // Build confirmed player email payloads.
        const confirmedPlayers = players
          .filter((p) => confirmedPlayerIds.has(p.availabilityId))
          .map((p) => ({
            playerFirstName: p.firstName,
            playerEmail: p.email,
            sessionDate: sessionDateLabel,
            startTime: startTimeLabel,
            locationName,
            notes: session.notes ?? null,
            cancelUrl: `${baseUrl}/portal/${p.signupToken}`,
          }))

        // Build tentative player email payloads.
        const tentativePlayers = players
          .filter((p) => !confirmedPlayerIds.has(p.availabilityId))
          .map((p) => ({
            playerFirstName: p.firstName,
            playerEmail: p.email,
            sessionDate: sessionDateLabel,
            deadlineLabel,
            cancelUrl: `${baseUrl}/portal/${p.signupToken}`,
          }))

        // Send confirmed reminders batch.
        if (confirmedPlayers.length > 0) {
          console.log(
            `[daily-8am] Check B: session ${session.id} — sending ${confirmedPlayers.length} confirmed reminder(s).`
          )
          const { sent, failed } = await sendConfirmedReminderBatch(confirmedPlayers)
          console.log(
            `[daily-8am] Check B: session ${session.id} — confirmed reminders: sent ${sent}, failed ${failed}.`
          )
          totalConfirmed += sent
        }

        // Send tentative reminders batch.
        if (tentativePlayers.length > 0) {
          console.log(
            `[daily-8am] Check B: session ${session.id} — sending ${tentativePlayers.length} tentative reminder(s).`
          )
          const { sent, failed } = await sendTentativeReminderBatch(tentativePlayers)
          console.log(
            `[daily-8am] Check B: session ${session.id} — tentative reminders: sent ${sent}, failed ${failed}.`
          )
          totalTentative += sent
        }

        // ----------------------------------------------------------------
        // Step 7: Close the session.
        // Set status → 'closed' and reminder_sent_at = now().
        // This is the final write — done after all emails are dispatched
        // so a partial email failure doesn't leave the session in an
        // ambiguous state (reminder_sent_at set but no emails sent).
        // ----------------------------------------------------------------
        const { error: closeError } = await supabaseAdmin
          .from('sessions')
          .update({
            status: 'closed',
            reminder_sent_at: new Date().toISOString(),
          })
          .eq('id', session.id)

        if (closeError) {
          console.error(
            `[daily-8am] Check B: CRITICAL — emails sent but failed to close session ${session.id}:`,
            closeError.message
          )
          // Log prominently but don't crash the whole cron — other sessions
          // should still be processed.
        } else {
          console.log(
            `[daily-8am] Check B: session ${session.id} closed. reminder_sent_at recorded.`
          )
          sessionsReminded++
        }
      } // end for loop over sessions

      outcomes.checkB = {
        sessionsReminded,
        confirmedRemindersSent: totalConfirmed,
        tentativeRemindersSent: totalTentative,
      }
      console.log('[daily-8am] Check B complete:', JSON.stringify(outcomes.checkB))
    }
  } catch (err) {
    console.error('[daily-8am] Check B: unexpected error:', err)
    outcomes.checkB = 'error'
  }

  // ==================================================================
  // CHECK C — Week close
  //
  // Decision tree (Phase 1 Section 4.5 Check C):
  //   1. Query weeks WHERE status = 'sent'.
  //   2. For each: check whether ALL child sessions have start_time < now().
  //   3. If yes: UPDATE weeks SET status = 'closed', closed_at = now().
  //
  // NOTE: Check B (reminder sends) always runs before Check C. This
  // ordering is mandatory — see Phase 2 Section 4.7 implementation notes.
  //
  // NOTE: The default start time check (Automation Logic Section 4.2)
  // should fire here at week close. This is deferred — not yet built.
  // ==================================================================
  console.log('[daily-8am] Check C: starting week close check.')

  try {
    // Fetch all weeks currently in 'sent' status along with their sessions.
    // We need session start times to determine if all sessions have passed.
    const { data: sentWeeks, error: weeksError } = await supabaseAdmin
      .from('weeks')
      .select(`
        id,
        week_start_date,
        sessions ( id, start_time, session_date )
      `)
      .eq('status', 'sent')

    if (weeksError) {
      console.error('[daily-8am] Check C: error querying weeks:', weeksError.message)
      outcomes.checkC = 'error'
    } else {
      console.log(`[daily-8am] Check C: found ${sentWeeks.length} week(s) in sent status.`)

      let weeksClosed = 0
      const nowIso = nowUtc.toISOString()

      for (const week of sentWeeks) {
        const sessions = week.sessions ?? []

        if (sessions.length === 0) {
          // A week with no sessions should not exist in normal operation.
          // Log and skip — do not close a week with no session data.
          console.warn(
            `[daily-8am] Check C: week ${week.id} has no sessions — skipping.`
          )
          continue
        }

        // Check whether all sessions have passed their start time.
        // A session has passed when its date + start_time is before now.
        // session_date is 'YYYY-MM-DD' and start_time is 'HH:MM:SS'.
        // Combine them into a full UTC datetime for comparison.
        const allPassed = sessions.every((session) => {
          if (!session.session_date || !session.start_time) {
            // Missing date or time — treat as not yet passed to be safe.
            return false
          }
          const sessionStart = new Date(
            `${session.session_date}T${session.start_time}Z`
          )
          return sessionStart < nowUtc
        })

        if (!allPassed) {
          console.log(
            `[daily-8am] Check C: week ${week.id} (${week.week_start_date}) — ` +
            `not all sessions have passed. Not closing yet.`
          )
          continue
        }

        // All sessions have passed — close the week.
        console.log(
          `[daily-8am] Check C: week ${week.id} (${week.week_start_date}) — ` +
          `all sessions passed. Closing week.`
        )

        const { error: closeError } = await supabaseAdmin
          .from('weeks')
          .update({
            status: 'closed',
            closed_at: nowIso,
          })
          .eq('id', week.id)

        if (closeError) {
          console.error(
            `[daily-8am] Check C: error closing week ${week.id}:`,
            closeError.message
          )
        } else {
          console.log(`[daily-8am] Check C: week ${week.id} successfully closed.`)
          // NOTE: default start time check deferred — will be added here
          // when that feature is built.
          weeksClosed++
        }
      }

      outcomes.checkC = { weeksClosed }
      console.log('[daily-8am] Check C complete:', JSON.stringify(outcomes.checkC))
    }
  } catch (err) {
    console.error('[daily-8am] Check C: unexpected error:', err)
    outcomes.checkC = 'error'
  }

  // ==================================================================
  // Final response
  // ==================================================================
  const elapsed = Date.now() - startTime
  console.log(`[daily-8am] All checks complete in ${elapsed}ms.`, JSON.stringify(outcomes))

  return new Response(
    JSON.stringify({ status: 'ok', outcomes, elapsedMs: elapsed }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}