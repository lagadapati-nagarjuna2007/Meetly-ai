-- ============================================================================
-- Migration: 20261019_meeting_duration_and_extensions.sql
-- Description: Mandatory Meeting Duration, Authoritative Deadline & Extension
-- 
-- 1. Adds duration_minutes (CHECK in 5, 15, 30, 40) to public.meetings
-- 2. Adds scheduled_end_time (TIMESTAMPTZ) to public.meetings
-- 3. Indexes scheduled_end_time for rapid active meeting expiration lookups
-- 4. Backfills existing active/waiting records safely
-- 5. Defines atomic stored procedure extend_meeting_duration with row locking,
--    privilege enforcement, and strict search_path isolation
-- 6. Grants permissions exclusively to authenticated, service_role, and postgres
-- ============================================================================

-- 1. Add duration_minutes and scheduled_end_time columns to meetings table
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'meetings' 
          AND column_name = 'duration_minutes'
    ) THEN
        ALTER TABLE public.meetings 
            ADD COLUMN duration_minutes INT DEFAULT 30;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'meetings' 
          AND column_name = 'scheduled_end_time'
    ) THEN
        ALTER TABLE public.meetings 
            ADD COLUMN scheduled_end_time TIMESTAMPTZ;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'meetings' 
          AND column_name = 'extension_count'
    ) THEN
        ALTER TABLE public.meetings 
            ADD COLUMN extension_count INT NOT NULL DEFAULT 0;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'meetings' 
          AND column_name = 'extension_used'
    ) THEN
        ALTER TABLE public.meetings 
            ADD COLUMN extension_used BOOLEAN NOT NULL DEFAULT false;
    END IF;
END $$;

-- 2. Index for rapid lookup of active meetings by scheduled_end_time
CREATE INDEX IF NOT EXISTS idx_meetings_active_scheduled_end 
    ON public.meetings (scheduled_end_time) 
    WHERE meeting_status = 'Active' AND is_deleted = false;

-- 3. Non-destructive backfill for existing records (runs BEFORE enforcing NOT NULL and CHECK constraints)
-- Backfill duration_minutes to 30 for any legacy records where it is NULL
UPDATE public.meetings
SET duration_minutes = 30
WHERE duration_minutes IS NULL;

-- Backfill extension tracking fields
UPDATE public.meetings
SET extension_count = 0
WHERE extension_count IS NULL;

UPDATE public.meetings
SET extension_used = false
WHERE extension_used IS NULL;

-- Backfill scheduled_end_time for existing Active meetings:
-- Step 3a: If started_at is present, scheduled_end_time = started_at + duration
UPDATE public.meetings
SET scheduled_end_time = started_at + (COALESCE(duration_minutes, 30) * INTERVAL '1 minute')
WHERE meeting_status = 'Active' 
  AND started_at IS NOT NULL 
  AND scheduled_end_time IS NULL;

-- Step 3b: If started_at is NULL but created_at is present, use created_at as authoritative start reference
UPDATE public.meetings
SET started_at = created_at,
    scheduled_end_time = created_at + (COALESCE(duration_minutes, 30) * INTERVAL '1 minute')
WHERE meeting_status = 'Active' 
  AND started_at IS NULL
  AND created_at IS NOT NULL 
  AND scheduled_end_time IS NULL;

-- Step 3c: If an active meeting has neither started_at nor created_at, its timing is
-- indeterminate. Rather than inventing arbitrary start times which could revive stale zombies,
-- safely transition the record to 'Ended'.
UPDATE public.meetings
SET meeting_status = 'Ended',
    ended_at = clock_timestamp(),
    updated_at = clock_timestamp()
WHERE meeting_status = 'Active'
  AND scheduled_end_time IS NULL;

-- 4. Enforce NOT NULL and Strict Check Constraints on duration_minutes and extension tracking
DO $$
BEGIN
    -- Enforce NOT NULL and defaults on duration_minutes and extension tracking
    -- (Safe now that NULL values have been backfilled in Step 3)
    ALTER TABLE public.meetings 
        ALTER COLUMN duration_minutes SET NOT NULL;
    ALTER TABLE public.meetings 
        ALTER COLUMN duration_minutes SET DEFAULT 30;

    ALTER TABLE public.meetings 
        ALTER COLUMN extension_count SET NOT NULL;
    ALTER TABLE public.meetings 
        ALTER COLUMN extension_count SET DEFAULT 0;

    ALTER TABLE public.meetings 
        ALTER COLUMN extension_used SET NOT NULL;
    ALTER TABLE public.meetings 
        ALTER COLUMN extension_used SET DEFAULT false;

    -- Replace permissive or legacy constraint with strict CHECK (duration_minutes IN (5, 15, 30, 40))
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'chk_meetings_duration_minutes'
          AND conrelid = 'public.meetings'::regclass
    ) THEN
        ALTER TABLE public.meetings 
            DROP CONSTRAINT chk_meetings_duration_minutes;
    END IF;

    ALTER TABLE public.meetings 
        ADD CONSTRAINT chk_meetings_duration_minutes 
        CHECK (duration_minutes IN (5, 15, 30, 40));

    -- Replace permissive or legacy constraint with strict CHECK (extension_count IN (0, 1))
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'chk_meetings_extension_count'
          AND conrelid = 'public.meetings'::regclass
    ) THEN
        ALTER TABLE public.meetings 
            DROP CONSTRAINT chk_meetings_extension_count;
    END IF;

    ALTER TABLE public.meetings 
        ADD CONSTRAINT chk_meetings_extension_count 
        CHECK (extension_count IN (0, 1));
END $$;

-- 5. Atomic Stored Procedure: extend_meeting_duration
-- Locks the meeting row, verifies active status and host authorization, and advances scheduled_end_time.
CREATE OR REPLACE FUNCTION public.extend_meeting_duration(
    p_meeting_id UUID,
    p_extension_minutes INT,
    p_requester_id UUID
)
RETURNS TABLE (
    success BOOLEAN,
    new_scheduled_end_time TIMESTAMPTZ,
    error_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_meeting RECORD;
    v_new_end_time TIMESTAMPTZ;
    v_active_host UUID;
BEGIN
    -- Input Validation
    IF p_meeting_id IS NULL THEN
        RETURN QUERY SELECT false, NULL::TIMESTAMPTZ, 'Meeting ID is required.'::TEXT;
        RETURN;
    END IF;

    IF p_requester_id IS NULL THEN
        RETURN QUERY SELECT false, NULL::TIMESTAMPTZ, 'Requester ID is required.'::TEXT;
        RETURN;
    END IF;

    -- Caller Role & Identity Verification
    -- This function is restricted to trusted backend roles (service_role, postgres).
    -- Defense-in-depth: If invoked through PostgREST in an authenticated user context,
    -- reject unless auth.uid() explicitly matches p_requester_id.
    IF auth.role() = 'authenticated' THEN
        IF auth.uid() IS NULL OR auth.uid() != p_requester_id THEN
            RETURN QUERY SELECT false, NULL::TIMESTAMPTZ, 'Unauthorized caller identity.'::TEXT;
            RETURN;
        END IF;
    END IF;

    -- Requirement 1: Explicitly reject NULL and any value other than 5, 10, or 15
    IF p_extension_minutes IS NULL OR p_extension_minutes NOT IN (5, 10, 15) THEN
        RETURN QUERY SELECT false, NULL::TIMESTAMPTZ, 'Extension minutes must be exactly 5, 10, or 15.'::TEXT;
        RETURN;
    END IF;

    -- Row Lock on Target Meeting to guarantee transaction serialization
    SELECT * INTO v_meeting
    FROM public.meetings
    WHERE meeting_id = p_meeting_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, NULL::TIMESTAMPTZ, 'Meeting not found.'::TEXT;
        RETURN;
    END IF;

    -- Status & Deletion Checks
    IF v_meeting.is_deleted = true THEN
        RETURN QUERY SELECT false, NULL::TIMESTAMPTZ, 'Meeting has been deleted.'::TEXT;
        RETURN;
    END IF;

    IF v_meeting.meeting_status != 'Active' THEN
        RETURN QUERY SELECT false, NULL::TIMESTAMPTZ, ('Meeting is not active (current status: ' || v_meeting.meeting_status || ').')::TEXT;
        RETURN;
    END IF;

    -- Requirement 2: NULL-safe Host Authorization Verification
    -- Requester must match active_host_id (or fallback to host_id if active_host_id is NULL).
    -- Uses IS NULL / IS DISTINCT FROM to guarantee NULL host identities are safely rejected.
    v_active_host := COALESCE(v_meeting.active_host_id, v_meeting.host_id);
    IF v_active_host IS NULL OR v_active_host IS DISTINCT FROM p_requester_id THEN
        RETURN QUERY SELECT false, NULL::TIMESTAMPTZ, 'Unauthorized. Only the active host can extend this meeting.'::TEXT;
        RETURN;
    END IF;

    -- Deadline Expiration Check:
    -- Cannot extend if current scheduled_end_time has already elapsed
    IF v_meeting.scheduled_end_time IS NOT NULL AND v_meeting.scheduled_end_time <= clock_timestamp() THEN
        RETURN QUERY SELECT false, NULL::TIMESTAMPTZ, 'Scheduled meeting end time has already elapsed.'::TEXT;
        RETURN;
    END IF;

    -- STRICT RULE: Maximum of ONE extension per meeting lifetime
    IF COALESCE(v_meeting.extension_count, 0) >= 1 OR COALESCE(v_meeting.extension_used, false) = true THEN
        RETURN QUERY SELECT false, NULL::TIMESTAMPTZ, 'This meeting has already used its one-time extension allowance.'::TEXT;
        RETURN;
    END IF;

    -- Calculate new scheduled end time
    v_new_end_time := COALESCE(v_meeting.scheduled_end_time, clock_timestamp()) + (p_extension_minutes * INTERVAL '1 minute');

    -- Atomically update scheduled_end_time, extension_count, extension_used, and updated_at
    UPDATE public.meetings
    SET scheduled_end_time = v_new_end_time,
        extension_count = 1,
        extension_used = true,
        updated_at = clock_timestamp()
    WHERE meeting_id = p_meeting_id;

    RETURN QUERY SELECT true, v_new_end_time, NULL::TEXT;
END;
$$;

-- 6. Atomic Stored Procedure: expire_meeting_if_eligible
-- Authoritatively evaluates current database clock_timestamp() to eliminate
-- application-server clock drift. Atomically transitions Active -> Ended if deadline passed.
CREATE OR REPLACE FUNCTION public.expire_meeting_if_eligible(
    p_meeting_id UUID
)
RETURNS TABLE (
    success BOOLEAN,
    room_name TEXT,
    meeting_code VARCHAR,
    host_id UUID,
    scheduled_end_time TIMESTAMPTZ,
    ended_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := clock_timestamp();
    v_updated RECORD;
BEGIN
    IF p_meeting_id IS NULL THEN
        RETURN QUERY SELECT false, NULL::TEXT, NULL::VARCHAR, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    UPDATE public.meetings
    SET meeting_status = 'Ended',
        ended_at = v_now,
        updated_at = v_now
    WHERE meeting_id = p_meeting_id
      AND meeting_status = 'Active'
      AND scheduled_end_time IS NOT NULL
      AND scheduled_end_time <= v_now
    RETURNING meetings.meeting_id, meetings.room_name, meetings.meeting_code, meetings.host_id, meetings.scheduled_end_time, meetings.ended_at
    INTO v_updated;

    IF v_updated.meeting_id IS NOT NULL THEN
        RETURN QUERY SELECT true, v_updated.room_name::TEXT, v_updated.meeting_code::VARCHAR, v_updated.host_id, v_updated.scheduled_end_time, v_updated.ended_at;
    ELSE
        RETURN QUERY SELECT false, NULL::TEXT, NULL::VARCHAR, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    END IF;
END;
$$;

-- 7. Strict Function Security & Permissions
-- Revoke execution from PUBLIC, anon, and authenticated.
-- Only trusted backend services (service_role) and superusers (postgres) may invoke these RPCs.
REVOKE ALL ON FUNCTION public.extend_meeting_duration(UUID, INT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.extend_meeting_duration(UUID, INT, UUID) TO service_role, postgres;

REVOKE ALL ON FUNCTION public.expire_meeting_if_eligible(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_meeting_if_eligible(UUID) TO service_role, postgres;

-- 8. Comment for Schema Documentation
COMMENT ON COLUMN public.meetings.duration_minutes IS 'Mandatory initial duration selected during meeting creation (5, 15, 30, or 40 minutes).';
COMMENT ON COLUMN public.meetings.scheduled_end_time IS 'Authoritative scheduled meeting termination timestamp; initialized upon activation and advanced by host extensions.';
COMMENT ON COLUMN public.meetings.extension_count IS 'Count of successful extensions granted for this meeting lifetime; capped strictly at 1.';
COMMENT ON COLUMN public.meetings.extension_used IS 'Boolean flag indicating whether this meeting has already consumed its one-time extension allowance.';
COMMENT ON FUNCTION public.extend_meeting_duration IS 'Atomically extends the authoritative scheduled_end_time of an active meeting by 5, 10, or 15 minutes under host authorization, strictly enforcing the one-extension lifetime limit.';
COMMENT ON FUNCTION public.expire_meeting_if_eligible IS 'Atomically evaluates the database-authoritative clock and transitions an expired active meeting to Ended.';

