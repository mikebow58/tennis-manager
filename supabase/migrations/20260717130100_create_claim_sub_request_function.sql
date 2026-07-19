-- Atomic confirm/decline claim for sub requests. Replaces the abandoned
-- Gemini version (dropped in migration 20260715120000). Built against the
-- actual dev schema and this project's two decisions:
--   (1) a broadcast stays active until every open spot is filled -- not
--       just the first responder (multi-spot support).
--   (2) when the last spot is filled, pre-existing tentative players on
--       this session are promoted to confirmed in the same transaction;
--       silently-demoted players (Case C) are promoted silently in turn.
--
-- Concurrency: the sub_requests row is locked FOR UPDATE immediately.
-- This serialises every confirm/decline attempt against the same
-- broadcast -- two players confirming the last spot simultaneously cannot
-- both succeed.
--
-- This function sends NO email. It performs the DB transaction only and
-- returns JSONB describing what happened, so the calling route
-- (app/api/subs/respond/route.js) can send the correct emails via
-- lib/email.js -- the project's single source of truth for outbound mail.

drop function if exists claim_sub_request(text, bigint, text);

create or replace function claim_sub_request(
  p_signup_token text,
  p_sub_id bigint,
  p_action text
) returns jsonb as $$
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

  v_tentative_count       int;
  v_target_subs_needed    int;
  v_confirmed_so_far      int;

  v_promoted_players      jsonb;
begin
  -- 1. Identify the player from their (static, non-rotating) signup token.
  select id, first_name || ' ' || last_name
    into v_player_id, v_full_name
  from players
  where signup_token = p_signup_token;

  if v_player_id is null then
    return jsonb_build_object('status', 'INVALID_PLAYER');
  end if;

  -- 2. Lock the target sub_requests row. This is what makes the whole
  --    function safe against two players responding at the same instant.
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

  -- 4. Security gate: the player must be a recipient of this broadcast.
  --    Lock this row too, guarding against the same player double-
  --    submitting the same action from two open tabs.
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

    -- Recompute, never decrement a stored counter (Phase 2 Section 6.5 --
    -- open spot count is always derived at query time). tentative count
    -- reflects players still waiting on this session's incomplete court(s)
    -- -- it doesn't change just because a new sub confirmed.
    select count(*) into v_tentative_count
    from availability
    where session_id = v_session_id and status = 'tentative';

    v_target_subs_needed := (4 - (v_tentative_count % 4)) % 4;
    if v_target_subs_needed = 0 and v_tentative_count > 0 then
      -- Safety fallback -- mirrors lib/sub-requests.js / Automation Logic
      -- Section 12.3. Should not occur in practice.
      v_target_subs_needed := 4;
    end if;

    select count(*) into v_confirmed_so_far
    from sub_request_recipients
    where sub_request_id = p_sub_id and response = 'confirmed';

    if v_target_subs_needed = 0 or v_confirmed_so_far >= v_target_subs_needed then
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

      update sub_requests
        set status = 'closed', filled_at = now(), filled_by_player_id = v_player_id
      where id = p_sub_id;

      -- Distinct from 'no_response' so a future admin report can tell
      -- "never got a chance to respond" apart from "had the chance, the
      -- broadcast closed before they answered."
      update sub_request_recipients
        set response = 'stale'
      where sub_request_id = p_sub_id
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
      'spots_remaining', v_target_subs_needed - v_confirmed_so_far
    );
  end if;

  return jsonb_build_object('status', 'INVALID_ACTION');
end;
$$ language plpgsql security definer;