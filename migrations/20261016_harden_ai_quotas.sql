-- ============================================================================
-- Meetly AI — AI Assistant Quota System Security Hardening
-- Migration: 20261016_harden_ai_quotas.sql
-- Description: Incremental migration for environments that already applied
--              the baseline meeting_ai_quotas table. Adds reservation tracking,
--              fixed search_path, explicit role privileges, concurrency locks,
--              and missing/deleted meeting safeguards.
-- ============================================================================

-- 1. Create meeting_ai_reservations table if it does not already exist
CREATE TABLE IF NOT EXISTS public.meeting_ai_reservations (
    reservation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL REFERENCES public.meetings(meeting_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL DEFAULT 'reserved' 
        CHECK (status IN ('reserved', 'completed', 'released')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meeting_ai_reservations_meeting_id ON public.meeting_ai_reservations(meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_ai_reservations_user ON public.meeting_ai_reservations(meeting_id, user_id);

-- 2. RLS Policies on meeting_ai_reservations
ALTER TABLE public.meeting_ai_reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny direct inserts to meeting_ai_reservations" ON public.meeting_ai_reservations;
CREATE POLICY "Deny direct inserts to meeting_ai_reservations"
    ON public.meeting_ai_reservations FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS "Deny direct updates to meeting_ai_reservations" ON public.meeting_ai_reservations;
CREATE POLICY "Deny direct updates to meeting_ai_reservations"
    ON public.meeting_ai_reservations FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS "Deny direct deletes to meeting_ai_reservations" ON public.meeting_ai_reservations;
CREATE POLICY "Deny direct deletes to meeting_ai_reservations"
    ON public.meeting_ai_reservations FOR DELETE
    USING (false);

DROP POLICY IF EXISTS "Users can only select their own reservations" ON public.meeting_ai_reservations;
CREATE POLICY "Users can only select their own reservations"
    ON public.meeting_ai_reservations FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- 3. Replace reserve_meeting_ai_question with hardened FOR SHARE locking and reservation tracking
CREATE OR REPLACE FUNCTION public.reserve_meeting_ai_question(
    p_meeting_id UUID,
    p_user_id UUID,
    p_email VARCHAR DEFAULT NULL,
    p_max_questions INTEGER DEFAULT 10,
    p_reservation_id UUID DEFAULT NULL
)
RETURNS TABLE (
    allowed BOOLEAN,
    questions_used INTEGER,
    questions_remaining INTEGER,
    message TEXT,
    reservation_id UUID
) 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_meeting_status VARCHAR;
    v_is_deleted BOOLEAN;
    v_current_used INTEGER;
    v_updated_used INTEGER;
    v_res_id UUID := COALESCE(p_reservation_id, gen_random_uuid());
    v_res_status VARCHAR;
    v_max_questions CONSTANT INTEGER := 10;
BEGIN
    SELECT meeting_status, is_deleted INTO v_meeting_status, v_is_deleted
    FROM public.meetings
    WHERE meeting_id = p_meeting_id
    FOR SHARE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 0, 0, 'Meeting not found.'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    IF v_is_deleted = true OR v_meeting_status = 'Ended' THEN
        RETURN QUERY SELECT false, 0, 0, 'This meeting has already ended.'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    SELECT status INTO v_res_status
    FROM public.meeting_ai_reservations
    WHERE reservation_id = v_res_id
    FOR UPDATE;

    IF FOUND THEN
        SELECT questions_used INTO v_current_used
        FROM public.meeting_ai_quotas
        WHERE meeting_id = p_meeting_id AND user_id = p_user_id;

        RETURN QUERY SELECT 
            (v_res_status = 'reserved' OR v_res_status = 'completed'),
            COALESCE(v_current_used, 0),
            GREATEST(0, v_max_questions - COALESCE(v_current_used, 0)),
            'Reservation already recorded.'::TEXT,
            v_res_id;
        RETURN;
    END IF;

    INSERT INTO public.meeting_ai_quotas (meeting_id, user_id, email, questions_used, created_at, updated_at)
    VALUES (p_meeting_id, p_user_id, LOWER(p_email), 0, NOW(), NOW())
    ON CONFLICT (meeting_id, user_id) 
    DO UPDATE SET 
        email = COALESCE(EXCLUDED.email, meeting_ai_quotas.email),
        updated_at = NOW();

    UPDATE public.meeting_ai_quotas
    SET 
        questions_used = questions_used + 1,
        updated_at = NOW()
    WHERE meeting_id = p_meeting_id 
      AND user_id = p_user_id
      AND questions_used < v_max_questions
    RETURNING questions_used INTO v_updated_used;

    IF v_updated_used IS NOT NULL THEN
        INSERT INTO public.meeting_ai_reservations (reservation_id, meeting_id, user_id, status, created_at, updated_at)
        VALUES (v_res_id, p_meeting_id, p_user_id, 'reserved', NOW(), NOW());

        RETURN QUERY SELECT 
            true, 
            v_updated_used, 
            GREATEST(0, v_max_questions - v_updated_used), 
            'Question reserved.'::TEXT,
            v_res_id;
        RETURN;
    ELSE
        SELECT questions_used INTO v_current_used
        FROM public.meeting_ai_quotas
        WHERE meeting_id = p_meeting_id AND user_id = p_user_id;

        RETURN QUERY SELECT 
            false, 
            COALESCE(v_current_used, v_max_questions), 
            0, 
            'You have used all 10 AI Assistant questions for this meeting.'::TEXT,
            NULL::UUID;
        RETURN;
    END IF;
END;
$$;

-- 4. Replace release_meeting_ai_question with idempotent reservation tracking
CREATE OR REPLACE FUNCTION public.release_meeting_ai_question(
    p_meeting_id UUID,
    p_user_id UUID,
    p_reservation_id UUID
)
RETURNS TABLE (
    success BOOLEAN,
    questions_used INTEGER,
    questions_remaining INTEGER,
    message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_res_status VARCHAR;
    v_updated_used INTEGER;
    v_current_used INTEGER;
    v_meeting_status VARCHAR;
    v_is_deleted BOOLEAN;
    v_max_questions CONSTANT INTEGER := 10;
BEGIN
    SELECT meeting_status, is_deleted INTO v_meeting_status, v_is_deleted
    FROM public.meetings
    WHERE meeting_id = p_meeting_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 0, 0, 'Meeting not found.'::TEXT;
        RETURN;
    END IF;

    IF v_meeting_status = 'Ended' OR v_is_deleted = true THEN
        RETURN QUERY SELECT false, 0, 0, 'This meeting has already ended.'::TEXT;
        RETURN;
    END IF;

    IF p_reservation_id IS NULL THEN
        RETURN QUERY SELECT false, 0, 0, 'Reservation ID required for release.'::TEXT;
        RETURN;
    END IF;

    SELECT status INTO v_res_status
    FROM public.meeting_ai_reservations
    WHERE reservation_id = p_reservation_id
      AND meeting_id = p_meeting_id
      AND user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        SELECT questions_used INTO v_current_used
        FROM public.meeting_ai_quotas
        WHERE meeting_id = p_meeting_id AND user_id = p_user_id;

        RETURN QUERY SELECT 
            false, 
            COALESCE(v_current_used, 0), 
            GREATEST(0, v_max_questions - COALESCE(v_current_used, 0)), 
            'Reservation record not found.'::TEXT;
        RETURN;
    END IF;

    IF v_res_status = 'released' THEN
        SELECT questions_used INTO v_current_used
        FROM public.meeting_ai_quotas
        WHERE meeting_id = p_meeting_id AND user_id = p_user_id;

        RETURN QUERY SELECT 
            false, 
            COALESCE(v_current_used, 0), 
            GREATEST(0, v_max_questions - COALESCE(v_current_used, 0)), 
            'Reservation was already released.'::TEXT;
        RETURN;
    END IF;

    IF v_res_status = 'completed' THEN
        SELECT questions_used INTO v_current_used
        FROM public.meeting_ai_quotas
        WHERE meeting_id = p_meeting_id AND user_id = p_user_id;

        RETURN QUERY SELECT 
            false, 
            COALESCE(v_current_used, 0), 
            GREATEST(0, v_max_questions - COALESCE(v_current_used, 0)), 
            'Reservation has already completed successfully and cannot be released.'::TEXT;
        RETURN;
    END IF;

    UPDATE public.meeting_ai_reservations
    SET status = 'released', updated_at = NOW()
    WHERE reservation_id = p_reservation_id;

    UPDATE public.meeting_ai_quotas
    SET 
        questions_used = GREATEST(0, questions_used - 1),
        updated_at = NOW()
    WHERE meeting_id = p_meeting_id 
      AND user_id = p_user_id
      AND questions_used > 0
    RETURNING questions_used INTO v_updated_used;

    IF v_updated_used IS NOT NULL THEN
        RETURN QUERY SELECT true, v_updated_used, GREATEST(0, v_max_questions - v_updated_used), 'Reservation released.'::TEXT;
    ELSE
        SELECT questions_used INTO v_current_used
        FROM public.meeting_ai_quotas
        WHERE meeting_id = p_meeting_id AND user_id = p_user_id;

        RETURN QUERY SELECT true, COALESCE(v_current_used, 0), GREATEST(0, v_max_questions - COALESCE(v_current_used, 0)), 'Reservation released.'::TEXT;
    END IF;
END;
$$;

-- 5. Complete function
CREATE OR REPLACE FUNCTION public.complete_meeting_ai_question(
    p_meeting_id UUID,
    p_user_id UUID,
    p_reservation_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.meeting_ai_reservations
    SET status = 'completed', updated_at = NOW()
    WHERE reservation_id = p_reservation_id
      AND meeting_id = p_meeting_id
      AND user_id = p_user_id
      AND status = 'reserved';
    RETURN FOUND;
END;
$$;

-- 6. Replace get_meeting_ai_quota with missing-meeting detection
CREATE OR REPLACE FUNCTION public.get_meeting_ai_quota(
    p_meeting_id UUID,
    p_user_id UUID,
    p_max_questions INTEGER DEFAULT 10
)
RETURNS TABLE (
    questions_used INTEGER,
    questions_remaining INTEGER,
    meeting_ended BOOLEAN,
    meeting_exists BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_used INTEGER;
    v_status VARCHAR;
    v_deleted BOOLEAN;
    v_max_questions CONSTANT INTEGER := 10;
BEGIN
    SELECT meeting_status, is_deleted INTO v_status, v_deleted
    FROM public.meetings
    WHERE meeting_id = p_meeting_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 0, 0, true, false;
        RETURN;
    END IF;

    IF v_status = 'Ended' OR v_deleted = true THEN
        RETURN QUERY SELECT 0, 0, true, true;
        RETURN;
    END IF;

    SELECT questions_used INTO v_used
    FROM public.meeting_ai_quotas
    WHERE meeting_id = p_meeting_id AND user_id = p_user_id;

    v_used := COALESCE(v_used, 0);

    RETURN QUERY SELECT 
        v_used, 
        GREATEST(0, v_max_questions - v_used), 
        false,
        true;
END;
$$;

-- 7. Replace cleanup_meeting_ai_quotas with row-level lock and cascading deletion
CREATE OR REPLACE FUNCTION public.cleanup_meeting_ai_quotas(
    p_meeting_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_deleted_count INTEGER;
BEGIN
    PERFORM 1 FROM public.meetings WHERE meeting_id = p_meeting_id FOR UPDATE;

    DELETE FROM public.meeting_ai_reservations
    WHERE meeting_id = p_meeting_id;

    DELETE FROM public.meeting_ai_quotas
    WHERE meeting_id = p_meeting_id;

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    RETURN v_deleted_count;
END;
$$;

-- 8. Explicit Permissions
REVOKE ALL ON FUNCTION public.reserve_meeting_ai_question(UUID, UUID, VARCHAR, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_meeting_ai_question(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_meeting_ai_question(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_meeting_ai_quota(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_meeting_ai_quotas(UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_meeting_ai_question(UUID, UUID, VARCHAR, INTEGER, UUID) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.release_meeting_ai_question(UUID, UUID, UUID) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.complete_meeting_ai_question(UUID, UUID, UUID) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.get_meeting_ai_quota(UUID, UUID, INTEGER) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.cleanup_meeting_ai_quotas(UUID) TO service_role, postgres;
