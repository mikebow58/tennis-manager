-- Migration: add court_rotations and court_notes tables
-- Date: 2026-06-11
--
-- PURPOSE:
--   Supports the racquet-rotation pairing feature and per-court organiser
--   notes on the Court Assignment Review screen (/admin/court-assignment/[sessionId]).
--
--   court_rotations: records which courts are paired for winners-up/losers-down
--   racquet rotation, which court is the "winners" court, and whether partners
--   switch each set or stay together.
--
--   court_notes: freeform organiser notes per court, for non-standard
--   instructions (e.g. "Joe & John keep partners all day for USTA prep").
--   Independent of court_rotations — a court can have a note with or without
--   being part of a rotation pair.
--
-- KEYING:
--   Both tables key on week_id + session_date rather than session_id, because
--   rotation pairing and notes are day-level concepts (like court letters),
--   not session-level. On multi-location days, multiple sessions share the
--   same week_id + session_date but rotation/notes are scoped per court_letter,
--   which is globally unique across the day (assigned by Procedure 2).
--
-- SAFETY REVIEW:
--   - Does this touch existing rows? No — both are new tables, no existing
--     data affected.
--   - Could it fail partway through? Each CREATE TABLE + grants + RLS block
--     is independent; if one table's block fails, the other is unaffected.
--     No multi-table transactions required.
--   - Rollback plan: DROP TABLE IF EXISTS public.court_rotations;
--     DROP TABLE IF EXISTS public.court_notes; — safe, no dependent objects.

-- =============================================================================
-- TABLE: court_rotations
-- =============================================================================

create table public.court_rotations (
  id uuid primary key default gen_random_uuid(),

  -- Day-level identifiers — pairing is scoped to a specific day's play,
  -- not to an individual session record (multi-location days share these).
  week_id uuid not null references public.weeks(id) on delete cascade,
  session_date date not null,

  -- The two paired courts, identified by court letter (e.g. 'A', 'B').
  -- Court letters are globally unique across a day (assigned by Procedure 2),
  -- so letter alone is sufficient — no location_id needed here.
  winners_court_letter text not null,
  second_court_letter text not null,

  -- 'rotate_partners' — players re-pair (racquet spin) when moving courts.
  -- 'keep_partners' — players keep their partner from the prior set when moving.
  rotation_type text not null check (rotation_type in ('rotate_partners', 'keep_partners')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A given court letter should not appear in more than one pairing on the
  -- same day. This is enforced at the application layer (UI prevents a court
  -- being selected in two pairings), not via a DB constraint, since enforcing
  -- "letter X appears in neither winners_court_letter nor second_court_letter
  -- of any other row for this day" requires a cross-row check that a simple
  -- CHECK constraint cannot express. Documented here for future reference.
  constraint court_rotations_distinct_courts check (winners_court_letter <> second_court_letter)
);

-- Index for the common lookup pattern: "all rotations for this day".
create index idx_court_rotations_week_date
  on public.court_rotations (week_id, session_date);

-- ---------------------------------------------------------------------------
-- Grants — required per Supabase Data API change (effective for new projects
-- from May 30, 2026). Without these, the table is invisible to PostgREST.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.court_rotations to service_role;
grant select, insert, update, delete on public.court_rotations to authenticated;
-- anon gets no access — intentional; matches RLS Access Model for all V2 tables.

-- ---------------------------------------------------------------------------
-- RLS — same access model as all other V2 tables.
-- service_role (API routes) bypasses RLS entirely.
-- authenticated (organiser session) gets full read/write.
-- anon gets nothing — enforced by absence of any anon policy.
-- ---------------------------------------------------------------------------
alter table public.court_rotations enable row level security;

create policy "authenticated full access on court_rotations"
  on public.court_rotations
  for all
  to authenticated
  using (true)
  with check (true);


-- =============================================================================
-- TABLE: court_notes
-- =============================================================================

create table public.court_notes (
  id uuid primary key default gen_random_uuid(),

  -- Same day-level keying rationale as court_rotations above.
  week_id uuid not null references public.weeks(id) on delete cascade,
  session_date date not null,

  -- The court this note applies to, identified by letter.
  court_letter text not null,

  -- Freeform organiser text. No structured logic — purely informational,
  -- read by players in the assignment email and on the printed lineup sheet.
  -- e.g. "Joe & John keep partners all day for USTA prep."
  note text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One note per court per day. The UI presents a single text field per
  -- court card — re-saving on a later approval should update, not duplicate.
  constraint court_notes_unique_court_per_day unique (week_id, session_date, court_letter)
);

-- Index for the common lookup pattern: "all notes for this day".
create index idx_court_notes_week_date
  on public.court_notes (week_id, session_date);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.court_notes to service_role;
grant select, insert, update, delete on public.court_notes to authenticated;
-- anon gets no access — intentional.

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.court_notes enable row level security;

create policy "authenticated full access on court_notes"
  on public.court_notes
  for all
  to authenticated
  using (true)
  with check (true);