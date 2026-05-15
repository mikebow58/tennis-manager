-- supabase/migrations/20260515000000_explicit_grants_v2_tables.sql
-- Explicit grants on all V2 tables ahead of Supabase Data API change (Oct 30 2026).
-- service_role: full access (used by supabaseAdmin in all server-side queries)
-- authenticated: full access gated by RLS policies
-- anon: no access (public-facing signup page uses token validation, not anon role)

do $$
declare
  t text;
begin
  foreach t in array array[
    'locations', 'default_sessions', 'waitlist', 'sub_requests',
    'sub_request_recipients', 'court_assignments', 'groups',
    'group_members', 'admin_settings', 'notifications'
  ]
  loop
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end;
$$;