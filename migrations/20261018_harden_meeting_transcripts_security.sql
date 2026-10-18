-- ==============================================================================
-- Meetly AI — Meeting Transcripts Security Hardening Migration
-- Date: 2026-10-18
--
-- Objective:
-- 1. Ensure Row Level Security (RLS) is active on public.meeting_transcripts.
-- 2. Revoke direct INSERT, UPDATE, DELETE, and SELECT permissions from
--    untrusted client roles (PUBLIC, anon, authenticated).
-- 3. Explicitly grant required permissions exclusively to trusted service_role.
-- 4. Ensure foreign key constraint references public.meetings(meeting_id)
--    with ON DELETE CASCADE to support the 2-hour retention cleanup cycle.
-- ==============================================================================

-- 1. Ensure Row Level Security (RLS) is enabled
ALTER TABLE IF EXISTS public.meeting_transcripts ENABLE ROW LEVEL SECURITY;

-- 2. Revoke direct table privileges from untrusted roles
-- Direct SELECT has already been denied; this ensures INSERT, UPDATE, and DELETE
-- cannot be performed directly from client Supabase SDK instances.
REVOKE ALL ON TABLE public.meeting_transcripts FROM PUBLIC;
REVOKE ALL ON TABLE public.meeting_transcripts FROM anon;
REVOKE ALL ON TABLE public.meeting_transcripts FROM authenticated;

-- 3. Grant full privileges exclusively to the backend service_role
GRANT ALL ON TABLE public.meeting_transcripts TO service_role;

-- 4. Idempotently ensure foreign key has ON DELETE CASCADE
-- This prevents retention cleanup (startRetentionCleanup in meetingController.js)
-- from failing with foreign key violation errors when hard-deleting expired meetings.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_name = 'meeting_transcripts'
      AND kcu.column_name = 'meeting_id'
  ) THEN
    ALTER TABLE public.meeting_transcripts
      DROP CONSTRAINT IF EXISTS meeting_transcripts_meeting_id_fkey;

    ALTER TABLE public.meeting_transcripts
      ADD CONSTRAINT meeting_transcripts_meeting_id_fkey
      FOREIGN KEY (meeting_id)
      REFERENCES public.meetings(meeting_id)
      ON DELETE CASCADE;
  ELSE
    ALTER TABLE public.meeting_transcripts
      ADD CONSTRAINT meeting_transcripts_meeting_id_fkey
      FOREIGN KEY (meeting_id)
      REFERENCES public.meetings(meeting_id)
      ON DELETE CASCADE;
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Foreign key check notice: %', SQLERRM;
END $$;
