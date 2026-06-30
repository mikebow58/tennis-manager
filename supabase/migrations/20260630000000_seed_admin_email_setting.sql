-- Migration: seed admin_settings.admin_email
-- Purpose: migrate ADMIN_EMAIL off the environment variable and into the
-- admin_settings table, so the organiser can edit it from the new admin
-- settings page instead of needing direct database/Vercel access.
--
-- This is a like-for-like cutover: the env var currently holds a single
-- address (mikelbowman@gmail.com), which is seeded here unchanged. Comma-
-- separated multi-recipient support is preserved by lib/admin-settings.js
-- (getAdminEmail/setAdminEmail), matching the existing ADMIN_EMAIL behavior.
--
-- Does this touch existing rows? No existing admin_settings row uses this
-- key yet — this is a new key, not an update to existing data.
-- Could it fail partway? Single insert, no multi-step risk.
-- Rollback: delete from admin_settings where key = 'admin_email';

-- Insert the admin_email key, seeded with the current ADMIN_EMAIL value.
-- ON CONFLICT guards against re-running this migration accidentally —
-- if the key already exists, leave it untouched rather than overwriting
-- any value the organiser may have already set via the settings page.
insert into public.admin_settings (key, value)
values ('admin_email', 'mikelbowman@gmail.com')
on conflict (key) do nothing;

-- NOTE: admin_settings already has explicit grants and RLS policies applied
-- from the original V2 schema migrations (20260510120000_grant_service_role.sql
-- and 20260515000000_explicit_grants_v2_tables.sql), since it's one of the
-- 14 existing V2 tables. No new grants needed here.