// lib/signup-schedule.js
//
// Single code-side source of truth for WHEN the weekly signup links go out,
// used only to build human-readable copy in organizer emails (week created,
// approval reminders, week approved).
//
// WHY CONSTANTS AND NOT AN admin_settings VALUE (Nov 17, 2026):
// The signup send is triggered by a Vercel cron whose schedule lives in
// vercel.json ("0 0 * * 4" = Thursday 00:00 UTC = Wednesday 6:00pm MDT).
// Changing a database setting cannot move a Vercel cron, so a settings row
// for the send day/time (the old admin_settings.signup_send_day /
// signup_send_time keys) could silently drift from the real schedule and
// make emails lie. Nothing in the codebase read those keys to schedule
// anything, and the settings page never exposed them. The schedule is
// therefore defined here, next to the code that must match it.
//
// IF YOU CHANGE THE SEND TIME you must change, together:
//   1. the schedule for /api/cron/weekly-signup-send in vercel.json
//   2. SIGNUP_SEND_DAY_NAME / SIGNUP_SEND_TIME_LABEL below
//   3. the two approval-reminder cron schedules in vercel.json, if they should
//      keep their relative lead time
//
// DAYLIGHT SAVING: the vercel.json schedule is written in MDT (UTC-6). In MST
// (UTC-7, early November to mid March) the send fires an hour earlier by the
// local clock (5:00pm), so the label below is accurate in MDT only. This is
// the same open DST decision that affects every cron; see the decisions log.
//
// References:
//   Nov 17, 2026 decision: signup send moved from Friday 9:30am to Wednesday
//   6:00pm so Mon/Tue sessions get the same signup window as other days.

/** Day of the week the signup links are sent (display only). */
export const SIGNUP_SEND_DAY_NAME = 'Wednesday'

/** Local (Mountain) time the signup links are sent (display only). */
export const SIGNUP_SEND_TIME_LABEL = '6:00pm'

/** e.g. "Wednesday at 6:00pm" — for use in organizer email copy. */
export const SIGNUP_SEND_LABEL = `${SIGNUP_SEND_DAY_NAME} at ${SIGNUP_SEND_TIME_LABEL}`