-- Grant service_role full access to all tables and sequences in the public schema.
-- Required for supabaseAdmin (service role key) to bypass RLS correctly.
-- Without this, the service role gets 403 permission denied at the table level
-- despite RLS being configured correctly.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
