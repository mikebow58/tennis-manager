/**
 * daily-8am — Vercel Cron Job
 *
 * Scheduled: 08:00 MDT daily (14:00 UTC, "0 14 * * *" in vercel.json).
 * Note: will drift 1 hour early in MST (November–March). See project
 * decisions log — accepted for now, revisit before first winter season.
 *
 * Three checks run every day. All three always run regardless of the
 * outcome of the others. Any combination may produce emissions.
 *
 * CHECK A — RETIRED as of a prior revision.
 *   Previously: a standalone pre-close fill-in check for Wed–Sat sessions
 *   scheduled for "tomorrow." This was never reachable in practice — by
 *   the time a Wed–Sat session's date is "tomorrow," its reminder has
 *   already fired 1–2 days earlier (per the day-of-week timing rule),
 *   which also flips sessions.status from 'open' to 'closed'. Check A's
 *   query filtered on status = 'open', so it could never match a Wed–Sat
 *   session in the wild. This was a timing assumption baked into the
 *   original Phase 1 cron map that was never reconciled against the
 *   reminder-timing rule once that rule was finalised.
 *
 *   FIX: the initial sub-request broadcast now fires from inside Check B,
 *   immediately after Procedure 1 determines a session closed short
 *   (Outcome B) — for every day of week, including Mon/Tue. This replaces
 *   Check A entirely. See Step 5.5 inside Check B below.
 *
 *   KNOWN FOLLOW-UP NOT YET FIXED: daily_10am_fillin_expansion still
 *   expects sessions.session_date = tomorrow relative to when the
 *   first_call sub_requests row was sent. That still holds for Mon/Tue
 *   (reminder fires 1 day prior). It no longer holds for Wed–Sat (reminder
 *   now fires 2 days prior from this new broadcast point), so the 10am
 *   expansion cron will not find and expand Wed–Sat first_call requests
 *   sent here. Needs a follow-up fix before the waitlist-first check
 *   (Phase 4) can be considered fully reliable for Wed–Sat sessions.
 *
 * CHECK B — Reminder sends. THIS REVISION: restructured from a single pass
 *   into two passes (see below) to fix a multi-location roster-in-reminder
 *   timing bug (post-beta item #5).
 *
 *   PASS 1 — Procedure 1 for every due-today session:
 *     For each session whose reminder is due today, runs Procedure 1
 *     (initial court balancing) and writes the resulting confirmed/tentative
 *     split to the availability table. No emails are sent in this pass and
 *     no session is closed yet (except the zero-signup case, which has
 *     nothing left to do and is closed immediately). Results are kept in
 *     memory for Pass 2.
 *
 *   PASS 2 — Roster building, broadcasts, sends, close:
 *     Only begins after every session in Pass 1 has been fully processed.
 *     This ordering guarantee is the actual fix: on a multi-location day,
 *     Session A's reminder email can safely include Session B's confirmed
 *     roster, because by the time Pass 2 runs, B's Procedure 1 has already
 *     completed and committed — there's no possibility of listing a player
 *     who is about to be (or already was, in the same run) demoted to
 *     tentative. A single-pass design couldn't guarantee this, since
 *     sessions aren't queried in a defined order and Session A could be
 *     processed before Session B ever reaches Procedure 1.
 *
 *     For each session: fires the initial sub-request broadcast if closed
 *     short (Step 5.5), builds the roster list (if the organiser's
 *     Communication setting is on — see lib/admin-settings.js
 *     getIncludeRosterInReminder), sends tiered reminder emails, and closes
 *     the session.
 *
 * CHECK C — Week close:
 *   Finds weeks in 'sent' status where all child sessions have passed
 *   their start time and transitions them to 'closed'.
 *
 * Tables read:  weeks, sessions, availability, players, locations,
 *               admin_settings
 * Tables written: sessions (status, reminder_sent_at),
 *                 availability (status, court_assignment_status),
 *                 sub_requests, sub_request_recipients,
 *                 weeks (status, closed_at)
 *
 * Emails sent:
 *   - Confirmed players: sendConfirmedReminderBatch (Check B Pass 2) —
 *     now optionally includes the roster of confirmed players (post-beta
 *     item #5)
 *   - Tentative players: sendTentativeReminderBatch (Check B Pass 2) —
 *     never includes the roster; the tiered reminder system's own design
 *     principle keeps this message status-only (Automation Logic §2.1)
 *   - First Call players: sendSubRequestBroadcast (Check B Pass 2, Step
 *     5.5, real player-facing confirm/decline email — only if session
 *     closed short and the First Call pool is non-empty)
 *
 * NOTE (cross-gender skill normalization, August 2026): the players select
 * in Step 2 below now includes `gender`, so resolveSkill() (lib/court-
 * balancing.js) can apply the fixed cross-gender comparison adjustment for
 * female players when Procedure 1 balances courts. See lib/court-balancing.js
 * for the full explanation. No other logic in this file changes — the
 * adjustment is entirely internal to resolveSkill().
 *
 * References:
 *   Phase 1 Cron Map — Section 4.5 (Check B) and Section 4.5 (Check C)
 *   Phase 2 State Machines — Section 4.4 (Procedure 1), Section 4.2
 *   Automation Logic — Section 2.1 (tiered reminder system), Section 12
 *     (cancellation and sub request logic — subsNeeded formula reused here)
 *   Project Summary — Section 21, "Roster in reminder email" (post-beta
 *     item #5)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  sendConfirmedReminderBatch,
  sendTentativeReminderBatch,
  sendSubRequestBroadcast,
} from '@/lib/email'
import { runProcedure1, resolveSkill, SKILL_SELF_TO_ADMIN } from '@/lib/court-balancing'
import { buildTargetingPool } from '@/lib/targeting'
import { getAdminEmail, getIncludeRosterInReminder } from '@/lib/admin-settings'
import { computeBroadcastDeadlineLabel } from '@/lib/sub-requests'

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

  const tomorrowDate = new Date(nowUtc)
  tomorrowDate.setUTCDate(nowUtc.getUTCDate() + 1)
  const tomorrowStr = toMountainDateStr(tomorrowDate)

  console.log('[daily-8am] Today (MT):', todayStr, '| Tomorrow (MT):', tomorrowStr)

  // Resolve the organiser email once up front — used by both Check B's
  // Step 5.5 stub broadcast and available for future use in this file.
  const adminEmail = await getAdminEmail()
  if (!adminEmail) {
    console.error('[daily-8am] getAdminEmail() returned no value — organiser alerts will be skipped where applicable')
  }

  // Resolve the roster-in-reminder Communication setting once up front —
  // read once per cron run rather than per session, since it can't change
  // mid-run and re-reading per session would just be wasted queries.
  const includeRosterInReminder = await getIncludeRosterInReminder()
  console.log(`[daily-8am] includeRosterInReminder setting: ${includeRosterInReminder}`)

  // Collect outcome summaries from each check for the final response.
  const outcomes = { checkA: null, checkB: null, checkC: null }

  // ==================================================================
  // CHECK A — RETIRED.
  //
  // Previously ran a standalone pre-close fill-in check for Wed–Sat
  // sessions dated "tomorrow." Removed because it could never match a
  // real session — see file header comment for the full explanation.
  // Its useful logic (targeting pool build, sub_requests insert,
  // sub_request_recipients insert, stub broadcast) has been folded into
  // Check B, Step 5.5 below, which fires at the correct moment: the
  // instant Procedure 1 determines a session closed short.
  // ==================================================================
  outcomes.checkA = {
    status: 'retired',
    note: 'Folded into Check B Step 5.5 — see file header comment.',
  }
  console.log('[daily-8am] Check A: retired. Logic now lives in Check B Step 5.5.')

  // ==================================================================
  // CHECK B — Reminder sends (two-pass — see file header comment)
  // ==================================================================
  console.log('[daily-8am] Check B: starting reminder send check.')

  try {
    // Fetch all open, un-reminded, non-cancelled sessions across all
    // weeks currently in 'sent' status. match_type is included — required
    // by buildTargetingPool in Step 5.5.
    const { data: openSessions, error: sessionsError } = await supabaseAdmin
      .from('sessions')
      .select(`
        id,
        session_date,
        start_time,
        courts_available,
        match_type,
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
      console.log(`[daily-8am] Check B: found ${openSessions.length} session(s) to evaluate.`)

      // Track totals across both passes for the final log summary.
      let sessionsReminded = 0
      let totalConfirmed = 0
      let totalTentative = 0
      let subRequestsFired = 0

      // Pass 1 results, keyed by session id. Only sessions that make it
      // all the way through Pass 1 successfully (Procedure 1 ran, DB
      // writes succeeded) get an entry here — those are the only ones
      // Pass 2 will process.
      const pass1Results = new Map()

      // ================================================================
      // PASS 1 — Procedure 1 for every due-today session.
      // No emails sent here. No sessions closed here (except the
      // zero-signup case, which has nothing left for Pass 2 to do).
      // ================================================================
      console.log('[daily-8am] Check B Pass 1: running Procedure 1 for due-today sessions.')

      for (const session of openSessions) {
        // ----------------------------------------------------------------
        // Step 1: Determine if reminder is due today for this session.
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
            `[daily-8am] Check B Pass 1: session ${session.id} (${session.session_date}) ` +
            `dayOfWeek=${dayOfWeek} daysPrior=${daysPrior} reminderDue=${reminderDateStr} today=${todayStr} — skipping.`
          )
          continue
        }

        console.log(
          `[daily-8am] Check B Pass 1: session ${session.id} (${session.session_date}) ` +
          `reminder due today — proceeding with Procedure 1.`
        )

        // ----------------------------------------------------------------
        // Step 2: Fetch all signed-up players for this session.
        // All players are currently in 'confirmed' status at this point —
        // 'tentative' is a Procedure 1 output, not set at signup time.
        // last_name is included — required to build "First L." roster
        // entries in Pass 2 (post-beta item #5). gender is included — used
        // by resolveSkill() (lib/court-balancing.js) for the cross-gender
        // comparison adjustment applied during Procedure 1's balancing.
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
              last_name,
              email,
              skill_admin,
              skill_self,
              gender,
              signup_token
            )
          `)
          .eq('session_id', session.id)
          .eq('status', 'confirmed')
          .order('created_at', { ascending: true }) // FIFO order preserved for tiebreaker

        if (availError) {
          console.error(
            `[daily-8am] Check B Pass 1: error fetching availability for session ${session.id}:`,
            availError.message
          )
          continue
        }

        const playerCount = availability.length
        console.log(
          `[daily-8am] Check B Pass 1: session ${session.id} has ${playerCount} signed-up player(s).`
        )

        if (playerCount === 0) {
          // No players signed up — close the session without sending any
          // reminders or firing a sub request. Nobody was ever confirmed,
          // so there's no tentative player and nothing to broadcast for.
          // Nothing for Pass 2 to do — closed immediately, not added to
          // pass1Results.
          console.log(
            `[daily-8am] Check B Pass 1: session ${session.id} has 0 players — closing with no reminders.`
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
        // resolveSkill() applies the cross-gender comparison adjustment
        // internally (see lib/court-balancing.js) — the resulting .skill
        // value here is comparison-only and never displayed to players
        // or the organiser.
        // ----------------------------------------------------------------
        const players = availability.map((avail) => ({
          availabilityId: avail.id,
          playerId: avail.player_id,
          firstName: avail.players.first_name,
          lastName: avail.players.last_name,
          email: avail.players.email,
          signupToken: avail.players.signup_token,
          createdAt: avail.created_at,
          skill: resolveSkill(avail.players),
        }))

        // ----------------------------------------------------------------
        // Step 4: Run Procedure 1 — Initial Court Balancing.
        // ----------------------------------------------------------------
        const { confirmedIds: confirmedPlayerIds, tentativeCount, bestScore, courtsCount } =
          runProcedure1(players)

        console.log(
          `[daily-8am] Check B Pass 1: Procedure 1 for session ${session.id} — ${playerCount} players, ` +
          `${courtsCount} full court(s), ${tentativeCount} tentative. ` +
          `bestScore=${bestScore}`
        )

        // ----------------------------------------------------------------
        // Step 5: Write Procedure 1 results to the availability table.
        // ----------------------------------------------------------------
        const confirmedAvailIds = players
          .filter((p) => confirmedPlayerIds.has(p.availabilityId))
          .map((p) => p.availabilityId)

        const tentativeAvailIds = players
          .filter((p) => !confirmedPlayerIds.has(p.availabilityId))
          .map((p) => p.availabilityId)

        let writeFailed = false

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
              `[daily-8am] Check B Pass 1: error writing tentative status for session ${session.id}:`,
              tentativeError.message
            )
            writeFailed = true
          } else {
            console.log(
              `[daily-8am] Check B Pass 1: session ${session.id} — ${tentativeAvailIds.length} player(s) set to tentative.`
            )
          }
        }

        // Confirmed players: court_assignment_status set to 'confirmed'.
        if (!writeFailed && confirmedAvailIds.length > 0) {
          const { error: confirmedError } = await supabaseAdmin
            .from('availability')
            .update({ court_assignment_status: 'confirmed' })
            .in('id', confirmedAvailIds)

          if (confirmedError) {
            console.error(
              `[daily-8am] Check B Pass 1: error writing confirmed court_assignment_status for session ${session.id}:`,
              confirmedError.message
            )
            writeFailed = true
          }
        }

        if (writeFailed) {
          // Do not add to pass1Results — if we can't write status we
          // shouldn't send reminders or include this session in any
          // sibling's combined roster, as players would receive the
          // wrong message tier or an inaccurate roster.
          continue
        }

        // Success — store everything Pass 2 needs, including this
        // session's own record (for week_id/session_date day-grouping,
        // locations, notes, etc.) and sessionDate (avoids recomputing).
        pass1Results.set(session.id, {
          session,
          sessionDate,
          players,
          confirmedPlayerIds,
          confirmedAvailIds,
          tentativeAvailIds,
        })
      } // end Pass 1 loop

      console.log(
        `[daily-8am] Check B Pass 1 complete. ${pass1Results.size} session(s) ready for Pass 2.`
      )

      // ================================================================
      // Build the day-grouping map used for multi-location combined
      // rosters. Only built after Pass 1 has fully finished — this is
      // the ordering guarantee that fixes the roster timing bug (see
      // file header comment).
      // ================================================================
      const sessionsByDay = new Map() // "weekId:sessionDate" -> [pass1Result, ...]
      for (const result of pass1Results.values()) {
        const dayKey = `${result.session.week_id}:${result.session.session_date}`
        if (!sessionsByDay.has(dayKey)) sessionsByDay.set(dayKey, [])
        sessionsByDay.get(dayKey).push(result)
      }

      // ================================================================
      // PASS 2 — Sub-request broadcasts, roster building, reminder sends,
      // session close. Every pass1Results entry reflects committed,
      // final Procedure 1 output for every due-today session — including
      // siblings on multi-location days.
      // ================================================================
      console.log('[daily-8am] Check B Pass 2: broadcasts, roster building, and sends.')

      for (const result of pass1Results.values()) {
        const {
          session,
          sessionDate,
          players,
          confirmedPlayerIds,
          confirmedAvailIds,
          tentativeAvailIds,
        } = result

        // ----------------------------------------------------------------
        // Step 5.5 — Fire the initial sub-request broadcast if this
        // session closed short.
        //
        // Fires for every day of week (Mon–Sat), per explicit decision —
        // Mon/Tue sessions closing short go straight to broadcast just
        // like Wed–Sat, rather than being excluded the way pre-close
        // fill-in logic used to exclude them (Automation Logic Section
        // 6.2's Mon/Tue exclusion applied to the old PRE-close targeted
        // send; this is a post-close initial broadcast and applies
        // uniformly).
        //
        // subsNeeded formula matches lib/sub-requests.js exactly, for
        // consistency with the cancellation-driven broadcast path.
        // ----------------------------------------------------------------
        if (tentativeAvailIds.length > 0) {
          let subsNeeded = (4 - (tentativeAvailIds.length % 4)) % 4
          if (subsNeeded === 0) subsNeeded = 4 // safety fallback — should not occur given tentativeAvailIds.length > 0

          console.log(
            `[daily-8am] Check B Pass 2 Step 5.5: session ${session.id} closed short — ` +
            `tentativeCount=${tentativeAvailIds.length} subsNeeded=${subsNeeded}. Firing initial broadcast.`
          )

          // Day-of-week label required by buildTargetingPool for the
          // unavailable_days exclusion check.
          const sessionDayLabel = sessionDate.toLocaleDateString('en-US', {
            weekday: 'long',
            timeZone: 'UTC',
          })

          const rosterSkills = players.map((p) => p.skill)
          const sessionMatchType = session.match_type ?? 'doubles'
          const locationName = session.locations?.name ?? 'TBD'

          const { firstCallPool } = await buildTargetingPool({
            sessionId: session.id,
            sessionDayLabel,
            sessionMatchType,
            rosterSkills,
          })

          console.log(
            `[daily-8am] Check B Pass 2 Step 5.5: session ${session.id} — firstCallPool size=${firstCallPool.length}`
          )

          // Insert sub_requests record. request_type = 'first_call' — this
          // session still has 1-2 days of lead time before the deadline
          // (6pm day prior), so First Call targeting is still appropriate
          // here rather than going straight to all_available.
          //
          // KNOWN GAP (see file header): daily_10am_fillin_expansion's
          // expectation that session_date = tomorrow no longer holds for
          // Wed-Sat sessions broadcast from here. Flagged for follow-up.
          const { data: subRequest, error: subInsertError } = await supabaseAdmin
            .from('sub_requests')
            .insert({
              session_id: session.id,
              sent_at: new Date().toISOString(),
              request_type: 'first_call',
              status: 'active',
            })
            .select('id')
            .single()

          if (subInsertError || !subRequest) {
            console.error(
              `[daily-8am] Check B Pass 2 Step 5.5: failed to insert sub_requests for session ${session.id}:`,
              subInsertError?.message
            )
          } else {
            console.log(
              `[daily-8am] Check B Pass 2 Step 5.5: sub_requests record created id=${subRequest.id} ` +
              `for session ${session.id}.`
            )

            if (firstCallPool.length > 0) {
              const recipientRows = firstCallPool.map((player) => ({
                sub_request_id: subRequest.id,
                player_id: player.playerId,
                sent_at: new Date().toISOString(),
                response: 'no_response',
              }))

              const { error: recipientsError } = await supabaseAdmin
                .from('sub_request_recipients')
                .insert(recipientRows)

              if (recipientsError) {
                console.error(
                  `[daily-8am] Check B Pass 2 Step 5.5: error inserting sub_request_recipients for session ${session.id}:`,
                  recipientsError.message
                )
              } else {
                console.log(
                  `[daily-8am] Check B Pass 2 Step 5.5: ${recipientRows.length} sub_request_recipients inserted.`
                )
              }
            } else {
              console.log(
                `[daily-8am] Check B Pass 2 Step 5.5: no First Call players in pool — ` +
                `sub_requests record created but no recipients inserted.`
              )
            }

            // Real player-facing broadcast — firstCallPool entries already
            // carry firstName/email/signupToken (buildPlayerPayload, lib/
            // targeting.js), the exact shape sendSubRequestBroadcast expects.
            // No adminEmail gate here — this send doesn't depend on the
            // organiser email being configured.
            if (firstCallPool.length > 0) {
              const sessionDateLabelForBroadcast = sessionDate.toLocaleDateString('en-US', {
                weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
              })
              const broadcastDeadlineLabel = await computeBroadcastDeadlineLabel(session.session_date)

              await sendSubRequestBroadcast(firstCallPool, {
                sessionDateLabel: sessionDateLabelForBroadcast,
                locationName,
                deadlineLabel: broadcastDeadlineLabel,
                subRequestId: subRequest.id,
              }).catch((err) =>
                console.error(`[daily-8am] Check B Pass 2 Step 5.5: broadcast send failed for session ${session.id}:`, err)
              )
            } else {
              console.log(
                `[daily-8am] Check B Pass 2 Step 5.5: no First Call players in pool for session ${session.id} — ` +
                `no broadcast email sent (sub_requests record created with zero recipients).`
              )
            }

            subRequestsFired++
          }
        } else {
          console.log(
            `[daily-8am] Check B Pass 2 Step 5.5: session ${session.id} closed full — no broadcast needed.`
          )
        }

        // ----------------------------------------------------------------
        // Step 6 — Build roster list (post-beta item #5), if enabled.
        //
        // Combines confirmed players from every session sharing this day
        // (same week_id + session_date) — the "full combined roster on
        // multi-location days" requirement. Deduped by player_id (defensive
        // — a player shouldn't normally have confirmed availability on two
        // sibling sessions the same day, but combining is done safely
        // either way). Sorted alphabetically by first name, formatted as
        // "First L.". Confirmed-tier only — never attached to the
        // tentative reminder, per the tiered reminder system's own design
        // principle (Automation Logic §2.1: tentative stays status-only).
        // ----------------------------------------------------------------
        let rosterNames = []
        if (includeRosterInReminder) {
          const dayKey = `${session.week_id}:${session.session_date}`
          const daySiblings = sessionsByDay.get(dayKey) || [result]

          const seenPlayerIds = new Set()
          const rosterEntries = []

          for (const sibling of daySiblings) {
            for (const p of sibling.players) {
              if (
                sibling.confirmedPlayerIds.has(p.availabilityId) &&
                !seenPlayerIds.has(p.playerId)
              ) {
                seenPlayerIds.add(p.playerId)
                rosterEntries.push({ firstName: p.firstName, lastName: p.lastName })
              }
            }
          }

          rosterEntries.sort((a, b) =>
            (a.firstName ?? '').localeCompare(b.firstName ?? '')
          )

          rosterNames = rosterEntries.map((p) => {
            const initial = p.lastName ? `${p.lastName.trim().charAt(0)}.` : ''
            return `${p.firstName ?? ''} ${initial}`.trim()
          })

          console.log(
            `[daily-8am] Check B Pass 2: session ${session.id} — roster built with ` +
            `${rosterNames.length} name(s) across ${daySiblings.length} sibling session(s).`
          )
        }

        // ----------------------------------------------------------------
        // Step 7: Build and send tiered reminder emails.
        // ----------------------------------------------------------------
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL

        const sessionDateLabel = sessionDate.toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          timeZone: 'UTC',
        })

        const startTimeLabel = session.start_time
          ? new Date(`1970-01-01T${session.start_time}Z`).toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
              timeZone: 'UTC',
            })
          : 'TBD'

        const locationName = session.locations?.name ?? 'TBD'

        const deadlineDate = new Date(sessionDate)
        deadlineDate.setUTCDate(sessionDate.getUTCDate() - 1)
        const deadlineDayName = deadlineDate.toLocaleDateString('en-US', {
          weekday: 'long',
          timeZone: 'UTC',
        })
        const deadlineTomorrowStr = toMountainDateStr(tomorrowDate)
        const deadlineDateStr = toMountainDateStr(deadlineDate)
        const deadlineLabel = deadlineDateStr === deadlineTomorrowStr
          ? 'tomorrow evening'
          : `${deadlineDayName} evening`

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
            rosterNames, // post-beta item #5 — empty array if setting is off
          }))

        const tentativePlayers = players
          .filter((p) => !confirmedPlayerIds.has(p.availabilityId))
          .map((p) => ({
            playerFirstName: p.firstName,
            playerEmail: p.email,
            sessionDate: sessionDateLabel,
            deadlineLabel,
            cancelUrl: `${baseUrl}/portal/${p.signupToken}`,
            // No rosterNames — tentative reminder stays status-only.
          }))

        if (confirmedPlayers.length > 0) {
          console.log(
            `[daily-8am] Check B Pass 2: session ${session.id} — sending ${confirmedPlayers.length} confirmed reminder(s).`
          )
          const { sent, failed } = await sendConfirmedReminderBatch(confirmedPlayers)
          console.log(
            `[daily-8am] Check B Pass 2: session ${session.id} — confirmed reminders: sent ${sent}, failed ${failed}.`
          )
          totalConfirmed += sent
        }

        if (tentativePlayers.length > 0) {
          console.log(
            `[daily-8am] Check B Pass 2: session ${session.id} — sending ${tentativePlayers.length} tentative reminder(s).`
          )
          const { sent, failed } = await sendTentativeReminderBatch(tentativePlayers)
          console.log(
            `[daily-8am] Check B Pass 2: session ${session.id} — tentative reminders: sent ${sent}, failed ${failed}.`
          )
          totalTentative += sent
        }

        // ----------------------------------------------------------------
        // Step 8: Close the session.
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
            `[daily-8am] Check B Pass 2: CRITICAL — emails sent but failed to close session ${session.id}:`,
            closeError.message
          )
        } else {
          console.log(
            `[daily-8am] Check B Pass 2: session ${session.id} closed. reminder_sent_at recorded.`
          )
          sessionsReminded++
        }
      } // end Pass 2 loop

      outcomes.checkB = {
        sessionsReminded,
        confirmedRemindersSent: totalConfirmed,
        tentativeRemindersSent: totalTentative,
        subRequestsFired,
      }
      console.log('[daily-8am] Check B complete:', JSON.stringify(outcomes.checkB))
    }
  } catch (err) {
    console.error('[daily-8am] Check B: unexpected error:', err)
    outcomes.checkB = 'error'
  }

  // ==================================================================
  // CHECK C — Week close
  // ==================================================================
  console.log('[daily-8am] Check C: starting week close check.')

  try {
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
          console.warn(
            `[daily-8am] Check C: week ${week.id} has no sessions — skipping.`
          )
          continue
        }

        const allPassed = sessions.every((session) => {
          if (!session.session_date || !session.start_time) {
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