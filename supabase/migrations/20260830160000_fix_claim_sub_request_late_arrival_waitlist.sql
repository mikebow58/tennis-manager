-- Migration: add late-arrival waitlist handling to claim_sub_request()
-- Date: 2026-08-30 (second fix this session — layers on top of
-- 20260830150000_fix_claim_sub_request_completion_check.sql)
--
-- BUG BEING FIXED (Gap 3, found during two-week cron load test, session 68,
-- Step 2 — testing a player attempting to confirm after both open spots
-- were already filled):
--
-- The CONFIRM branch's `if v_sub_status = 'closed' then return
-- ALREADY_FILLED` told a late-responding player outright that the spot was
-- already taken. Phase 3 Group 3 ("Player responds to sub request after
-- spot already filled") is explicit: the player must be silently added to
-- the bottom of the unified dynamic waitlist instead, and must receive NO
-- indication that the spot was already filled.
--
-- ALSO FIXED: app/subs/respond/page.js (see accompanying full-file
-- replacement) was independently revealing this before the player even
-- attempted a response -- its GET handler showed "Spot already filled"
-- for any recipient whose broadcast was already closed, before they ever
-- clicked "Yes, I'll play." That reveal happened regardless of what this
-- SQL function did, so both had to change together: this function now
-- returns a genuine waitlist outcome instead of ALREADY_FILLED, and the
-- page now shows the same open-looking buttons to a not-yet-responded
-- recipient (response = 'no_response' or 'stale') regardless of the
-- underlying sub_request's status -- the closed/open distinction is only
-- ever resolved server-side, at the moment of an actual confirm attempt,
-- never revealed passively on page load.
--
-- WHAT CHANGED IN THIS FUNCTION:
--   1. Step 1 now also captures first_name and email directly, so the new
--      SUCCESS_WAITLISTED branch can return everything
--      app/api/subs/respond/route.js needs to send the waitlist-
--      confirmation email, without a second round-trip query.
--   2. New idempotency guard: a recipient whose own response is already
--      'waitlisted' (e.g. double-submit, or revisiting the link) gets
--      ALREADY_ON_WAITLIST rather than a duplicate availability insert.
--   3. The `v_sub_status = 'closed'` branch no longer returns
--      ALREADY_FILLED. It now marks this recipient's response as
--      'waitlisted', inserts (or reactivates) their availability record
--      as status = 'waitlisted' (created_at = now(), for correct FIFO
--      position per Automation Logic Section 11), and returns
--      SUCCESS_WAITLISTED. The now-closed sub_request itself is left
--      untouched -- it does not get reopened or otherwise modified.
--
-- NOT addressed by this migration: Gap 1 (Procedure 2 never invoked when
-- a session reaches full status via this function) is still open and
-- unrelated to this fix.
--
-- Rollback: re-apply 20260830150000_fix_claim_sub_request_completion_check.sql
-- to revert to the pre-Gap-3 behavior (ALREADY_FILLED, no waitlist insert).

CREATE OR REPLACE FUNCTION public.claim_sub_request(p_signup_token text, p_sub_id bigint, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_player_id            bigint;
  v_first_name            text;
  v_email                 text;
  v_full_name             text;

  v_sub_status            text;
  v_session_id            bigint;
  v_session_cancelled_at  timestamptz;
  v_session_date          date;
  v_session_date_label    text;

  v_recipient_id          bigint;
  v_recipient_response    text;

  v_existing_avail_id     bigint;

  v_confirmed_count       int;
  v_tentative_count       int;
  v_total_signed_up       int;
  v_is_full               boolean;

  v_promoted_players      jsonb;
  v_active_sub_ids        bigint[];
begin
  -- 1. Identify the player from their (static, non-rotating) signup token.
  --    BUG FIX (Gap 3): now also captures first_name/email directly, so
  --    the SUCCESS_WAITLISTED branch below can return everything
  --    app/api/subs/respond/route.js needs to send the waitlist-
  --    confirmation email without a second round-trip query.
  select id, first_name, email, first_name || ' ' || last_name
    into v_player_id, v_first_name, v_email, v_full_name
  from players
  where signup_token = p_signup_token;

  if v_player_id is null then
    return jsonb_build_object('status', 'INVALID_PLAYER');
  end if;

  -- 2. Lock the target sub_requests row. Identifies the session and this
  --    specific broadcast's own current status.
  select sr.status, sr.session_id, s.cancelled_at, s.session_date
    into v_sub_status, v_session_id, v_session_cancelled_at, v_session_date
  from sub_requests sr
  join sessions s on s.id = sr.session_id
  where sr.id = p_sub_id
  for update of sr;

  if v_sub_status is null then
    return jsonb_build_object('status', 'INVALID_SUB_REQUEST');
  end if;

  v_session_date_label := coalesce(
    to_char(v_session_date, 'FMDay, FMMonth FMDD, YYYY'),
    'Unknown date'
  );

  -- 3. A cancelled session always takes priority.
  if v_session_cancelled_at is not null then
    return jsonb_build_object('status', 'SESSION_CANCELLED');
  end if;

  -- 3.5 Lock every active sub_requests row for this session -- not just
  --     p_sub_id -- before any completion check runs. See the Gap 2
  --     migration (20260830150000) for the full explanation and the
  --     deadlock-avoidance rationale for the fixed id ordering.
  select array_agg(id order by id)
    into v_active_sub_ids
  from (
    select id
    from sub_requests
    where session_id = v_session_id
      and status = 'active'
    order by id
    for update
  ) locked_active_requests;

  -- 4. Security gate: the player must be a recipient of THIS specific
  --    broadcast (p_sub_id) -- a player only ever sees a confirm link
  --    for the broadcast they were actually sent. Lock this row too,
  --    guarding against the same player double-submitting the same
  --    action from two open tabs.
  select id, response
    into v_recipient_id, v_recipient_response
  from sub_request_recipients
  where sub_request_id = p_sub_id and player_id = v_player_id
  for update;

  if v_recipient_id is null then
    return jsonb_build_object('status', 'NOT_RECIPIENT');
  end if;

  -- 5. DECLINE -- no roster impact. A player who already confirmed can't
  --    retroactively decline through this link.
  if p_action = 'decline' then
    if v_recipient_response = 'confirmed' then
      return jsonb_build_object(
        'status', 'ALREADY_CONFIRMED_BY_YOU',
        'player_name', v_full_name,
        'session_date_label', v_session_date_label
      );
    end if;

    update sub_request_recipients
      set response = 'declined', responded_at = now()
    where id = v_recipient_id;

    return jsonb_build_object(
      'status', 'DECLINED_SUCCESS',
      'player_name', v_full_name,
      'session_date_label', v_session_date_label
    );
  end if;

  -- 6. CONFIRM
  if p_action = 'confirm' then
    if v_recipient_response = 'confirmed' then
      return jsonb_build_object(
        'status', 'ALREADY_CONFIRMED_BY_YOU',
        'player_name', v_full_name,
        'session_date_label', v_session_date_label
      );
    end if;

    if v_recipient_response = 'declined' then
      -- Declined players are excluded from further contact for this
      -- session (Phase 2 Section 7.1). No path back through this link.
      return jsonb_build_object('status', 'ALREADY_DECLINED');
    end if;

    -- BUG FIX (Gap 3): a player who already landed on the waitlist through
    -- this exact link (double-submit, or revisiting the page) gets an
    -- idempotent response rather than a duplicate availability insert.
    if v_recipient_response = 'waitlisted' then
      return jsonb_build_object(
        'status', 'ALREADY_ON_WAITLIST',
        'player_name', v_full_name,
        'session_date_label', v_session_date_label
      );
    end if;

    -- BUG FIX (Gap 3): previously, v_sub_status = 'closed' returned
    -- ALREADY_FILLED here -- directly telling a late respondent their
    -- spot was already taken. Phase 3 Group 3 requires silently adding
    -- them to the waitlist instead, with NO indication the spot was
    -- already filled. This branch does that: inserts (or reactivates) an
    -- availability row as 'waitlisted' and returns an outcome that reads
    -- exactly like a normal, positive confirmation to the caller --
    -- app/subs/respond/page.js and app/api/subs/respond/route.js must
    -- never surface "already filled" language for this outcome. The
    -- now-closed sub_request itself is left untouched.
    if v_sub_status = 'closed' then
      update sub_request_recipients
        set response = 'waitlisted', responded_at = now()
      where id = v_recipient_id;

      select id into v_existing_avail_id
      from availability
      where session_id = v_session_id and player_id = v_player_id;

      if v_existing_avail_id is not null then
        update availability
          set status = 'waitlisted',
              court_assignment_status = null,
              cancelled_at = null
        where id = v_existing_avail_id;
      else
        insert into availability (session_id, player_id, status, created_at)
        values (v_session_id, v_player_id, 'waitlisted', now());
      end if;

      return jsonb_build_object(
        'status', 'SUCCESS_WAITLISTED',
        'player_name', v_full_name,
        'player_first_name', v_first_name,
        'player_email', v_email,
        'session_date_label', v_session_date_label
      );
    end if;

    if v_sub_status <> 'active' then
      return jsonb_build_object('status', 'NOT_ACTIVE');
    end if;

    update sub_request_recipients
      set response = 'confirmed', responded_at = now()
    where id = v_recipient_id;

    -- Paired status + court_assignment_status update matches the existing
    -- convention used everywhere else a player becomes confirmed via this
    -- subsystem (see lib/sub-requests.js Case B / Case D promotions).
    select id into v_existing_avail_id
    from availability
    where session_id = v_session_id and player_id = v_player_id;

    if v_existing_avail_id is not null then
      update availability
        set status = 'confirmed',
            court_assignment_status = 'confirmed',
            cancelled_at = null
      where id = v_existing_avail_id;
    else
      insert into availability (session_id, player_id, status, court_assignment_status)
      values (v_session_id, v_player_id, 'confirmed', 'confirmed');
    end if;

    -- Completion is determined from the SESSION's total signed-up count
    -- against a clean multiple of 4 -- not from a tally scoped to
    -- p_sub_id's own recipients. See Gap 2 migration (20260830150000).
    select count(*) into v_confirmed_count
    from availability
    where session_id = v_session_id and status = 'confirmed';

    select count(*) into v_tentative_count
    from availability
    where session_id = v_session_id and status = 'tentative';

    v_total_signed_up := v_confirmed_count + v_tentative_count;
    v_is_full := v_total_signed_up > 0 and v_total_signed_up % 4 = 0;

    if v_is_full then
      select coalesce(jsonb_agg(jsonb_build_object(
               'player_id', a.player_id,
               'first_name', p.first_name,
               'email', p.email,
               'signup_token', p.signup_token,
               'needs_email', not a.silently_demoted
             )), '[]'::jsonb)
        into v_promoted_players
      from availability a
      join players p on p.id = a.player_id
      where a.session_id = v_session_id and a.status = 'tentative';

      update availability
        set status = 'confirmed',
            court_assignment_status = 'confirmed',
            silently_demoted = false
      where session_id = v_session_id and status = 'tentative';

      update sub_requests
        set status = 'closed', filled_at = now(), filled_by_player_id = v_player_id
      where id = any(v_active_sub_ids);

      update sub_request_recipients
        set response = 'stale'
      where sub_request_id = any(v_active_sub_ids)
        and id <> v_recipient_id
        and response = 'no_response';

      return jsonb_build_object(
        'status', 'SUCCESS_COMPLETE',
        'player_name', v_full_name,
        'session_date_label', v_session_date_label,
        'promoted_players', v_promoted_players
      );
    end if;

    return jsonb_build_object(
      'status', 'SUCCESS_PARTIAL',
      'player_name', v_full_name,
      'session_date_label', v_session_date_label,
      'spots_remaining', (4 - (v_total_signed_up % 4))
    );
  end if;

  return jsonb_build_object('status', 'INVALID_ACTION');
end;
$function$
