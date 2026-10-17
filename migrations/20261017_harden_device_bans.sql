-- ============================================================================
-- Migration: 20261017_harden_device_bans.sql
-- Description: Security hardening for Meetly AI Meeting Device Bans
-- 
-- 1. Enable Row Level Security (RLS) on public.meeting_device_bans
-- 2. Revoke unauthorized public/anon/authenticated permissions on ban table
-- 3. Grant table permissions exclusively to trusted service_role & postgres
-- 4. Harden ban_device_tx stored procedure with fixed search_path,
--    schema-qualified objects, input validation, and row locking
-- 5. Revoke EXECUTE on ban_device_tx from PUBLIC, anon, and authenticated
-- 6. Grant EXECUTE on ban_device_tx exclusively to service_role & postgres
-- ============================================================================

-- 1. Ensure table and constraints exist (compatible with existing databases)
CREATE TABLE IF NOT EXISTS public.meeting_device_bans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_code VARCHAR(255) NOT NULL,
    device_fingerprint VARCHAR(255) NOT NULL,
    blocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_meeting_device_ban UNIQUE (meeting_code, device_fingerprint)
);

-- Index for rapid join-time ban verification
CREATE INDEX IF NOT EXISTS idx_meeting_device_bans_lookup 
    ON public.meeting_device_bans (meeting_code, device_fingerprint);

-- 2. Enable Row Level Security (RLS)
ALTER TABLE public.meeting_device_bans ENABLE ROW LEVEL SECURITY;

-- 3. Strict Privilege Revocations on Table
REVOKE ALL ON TABLE public.meeting_device_bans FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.meeting_device_bans TO service_role, postgres;

-- 4. Idempotent Policy for trusted service role
DROP POLICY IF EXISTS service_role_all_meeting_device_bans ON public.meeting_device_bans;
CREATE POLICY service_role_all_meeting_device_bans ON public.meeting_device_bans
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- 5. Hardened Atomic Transaction Function: ban_device_tx
CREATE OR REPLACE FUNCTION public.ban_device_tx(
    p_meeting_code TEXT,
    p_user_id UUID
)
RETURNS VARCHAR
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_code VARCHAR(255);
    v_meeting_id UUID;
    v_meeting_status VARCHAR(50);
    v_is_deleted BOOLEAN;
    v_fingerprint VARCHAR(255);
    v_participant_id UUID;
BEGIN
    -- Input Validation
    IF p_meeting_code IS NULL OR length(trim(p_meeting_code)) = 0 THEN
        RAISE EXCEPTION 'Meeting code is required';
    END IF;

    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'User ID is required';
    END IF;

    v_clean_code := upper(trim(p_meeting_code));

    -- Verify meeting exists and lock row with FOR SHARE to coordinate with meeting termination
    SELECT meeting_id, meeting_status, is_deleted
    INTO v_meeting_id, v_meeting_status, v_is_deleted
    FROM public.meetings
    WHERE meeting_code = v_clean_code
    FOR SHARE;

    IF v_meeting_id IS NULL THEN
        RAISE EXCEPTION 'Meeting not found';
    END IF;

    IF v_meeting_status = 'Ended' OR v_is_deleted = true THEN
        RAISE EXCEPTION 'This meeting has already ended';
    END IF;

    -- Locate participant record for this meeting & user
    SELECT participant_id, device_fingerprint
    INTO v_participant_id, v_fingerprint
    FROM public.participants
    WHERE meeting_id = v_meeting_id
      AND user_id = p_user_id
    ORDER BY joined_at DESC
    LIMIT 1;

    -- Fallback to pending join requests if participant hasn't completed entry
    IF v_fingerprint IS NULL OR length(trim(v_fingerprint)) = 0 THEN
        SELECT device_fingerprint
        INTO v_fingerprint
        FROM public.meeting_join_requests
        WHERE meeting_code = v_clean_code
          AND user_id = p_user_id
        ORDER BY created_at DESC
        LIMIT 1;
    END IF;

    IF v_fingerprint IS NULL OR length(trim(v_fingerprint)) = 0 THEN
        RAISE EXCEPTION 'Participant has no recorded device fingerprint';
    END IF;

    -- Insert ban record idempotently
    INSERT INTO public.meeting_device_bans (meeting_code, device_fingerprint, blocked_at)
    VALUES (v_clean_code, v_fingerprint, now())
    ON CONFLICT (meeting_code, device_fingerprint) DO NOTHING;

    -- Mark participant status as removed in public.participants
    IF v_participant_id IS NOT NULL THEN
        UPDATE public.participants
        SET participant_status = 'removed',
            left_at = now()
        WHERE participant_id = v_participant_id;
    END IF;

    -- Also clean up any active or pending join requests for this user
    DELETE FROM public.meeting_join_requests
    WHERE meeting_code = v_clean_code
      AND user_id = p_user_id;

    RETURN v_fingerprint;
END;
$$;

-- 6. Restrict Function Privileges
REVOKE EXECUTE ON FUNCTION public.ban_device_tx(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ban_device_tx(TEXT, UUID) TO service_role, postgres;
