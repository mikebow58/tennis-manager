-- Migration: fix claim_sub_request() completion detection
-- Date: 2026-08-30
--
-- BUG BEING FIXED (found during two-week cron load test, session 68):
-- The prior version of this function determined "are all open spots
-- filled?" by counting confirmations scoped to sub_request_recipients
-- WHERE sub_request_id = p_sub_id -- i.e. only among recipients of the
-- ONE broadcast the responding player happened to click through.
--
-- A session frequently has more than one active sub_request running in
-- parallel -- e.g. the original first_call broadcast (daily-8am Check B
-- Step 5.5) plus the 10am all_available expansion for the same session.
-- When two different respondents confirmed against two different
-- SIBLING sub_requests, each call's completion check only ever saw its
-- own broadcast's confirmations (always 1), never reaching the target
-- count -- even though together the two confirmations exactly filled
-- every open spot. Result: both sub_requests were left permanently
-- 'active' with filled_at still NULL, and the originally-tentative
-- players were never promoted to 'confirmed', despite the session
-- roster being genuinely complete.
--
-- FIX: completion is now derived from the SESSION's total signed-up
-- count (confirmed + tentative) against a clean multiple of 4 -- the
-- same principle already applied to the dashboard's computeSessionDisplay
-- fix earlier this session: "how many spots remain open" is a property
-- of the session's roster, not of which specific broadcast a given
-- confirmation arrived through. When full, EVERY active sub_request for
-- the session is closed, not just p_sub_id.
--
-- CONCURRENCY NOTE: all active sub_requests for the session are now
-- locked (FOR UPDATE) up front, in a fixed id order, before the
-- completion check runs. This prevents the same race at a shorter
-- timescale -- two respondents confirming via two different sibling
-- sub_requests at nearly the same instant. Locking in a fixed order
-- means two concurrent calls against different sibling requests on the
-- same session always request locks in the same sequence and cannot
-- deadlock against each other.
--
-- Postgres does not allow `FOR UPDATE` directly on a query using an
-- aggregate function (array_agg), so the lock is taken in an inner
-- subquery and aggregated in the outer query.
--
-- NOT addressed by this migration (tracked separately): Procedure 2
-- (lib/court-assignment.js runProcedure2) is still never invoked when a
-- session reaches full status via this function -- SUCCESS_COMPLETE
-- currently only triggers promotion + organiser-notice emails in
-- app/api/subs/respond/route.js. Per Phase 2 Section 4.5 Trigger A,
-- reaching full status post-close should fire Procedure 2 event-driven,
-- immediately. That is a JS-side fix in route.js, not this SQL function,
-- and is the next item on the list after this migration is verified.
--
-- Rollback: previous function body is preserved in this project's dev
-- session notes (pulled via pg_get_functiondef prior to this migration).
-- Re-running that CREATE OR REPLACE reverts this change if needed.

CREATE OR REPLACE FUNCTION public.claim_sub_request(p_signup_token text, p_sub_id bigint, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_player_id            bigint;
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
  select id, first_name || ' ' || last_name
    into v_player_id, v_full_name
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

  -- 3.5 BUG FIX: lock every active sub_requests row for this session --
  --     not just p_sub_id -- before any completion check runs. See file
  --     header for the full explanation and the deadlock-avoidance
  --     rationale for the fixed id ordering. The FOR UPDATE lock is taken
  --     in the inner subquery; array_agg (an aggregate, which Postgres
  --     disallows combining directly with FOR UPDATE) is applied in the
  --     outer query against the already-locked rows.
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

    if v_sub_status = 'closed' then
      return jsonb_build_object('status', 'ALREADY_FILLED');
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

    -- BUG FIX: completion is now determined from the SESSION's total
    -- signed-up count against a clean multiple of 4 -- not from a tally
    -- scoped to p_sub_id's own recipients. See file header. tentative
    -- count is still read (kept for parity with the subsNeeded formula
    -- used elsewhere, e.g. lib/sub-requests.js) but no longer drives the
    -- completion decision by itself -- only the combined total does.
    select count(*) into v_confirmed_count
    from availability
    where session_id = v_session_id and status = 'confirmed';

    select count(*) into v_tentative_count
    from availability
    where session_id = v_session_id and status = 'tentative';

    v_total_signed_up := v_confirmed_count + v_tentative_count;
    v_is_full := v_total_signed_up > 0 and v_total_signed_up % 4 = 0;

    if v_is_full then
      -- All open spots filled. Collect the still-tentative players' info
      -- (and silently_demoted flag) BEFORE promoting them, so the caller
      -- knows exactly who still needs the promotion email.
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

      -- BUG FIX: close EVERY active sub_request for this session (using
      -- the array locked in step 3.5), not just p_sub_id -- a sibling
      -- broadcast can still be sitting active if this confirmation came
      -- in through a later expansion, and vice versa. filled_by_player_id
      -- is recorded on every closed request so an admin looking at any of
      -- them can see who ultimately completed the roster.
      update sub_requests
        set status = 'closed', filled_at = now(), filled_by_player_id = v_player_id
      where id = any(v_active_sub_ids);

      -- Mark every other outstanding recipient across ALL of this
      -- session's now-closed requests as 'stale' -- distinct from
      -- 'no_response' so a future admin report can tell "never got a
      -- chance to respond" apart from "had the chance, the broadcast
      -- closed before they answered."
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
