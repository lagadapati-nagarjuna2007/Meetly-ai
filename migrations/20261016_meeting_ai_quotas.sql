-- ============================================================================
-- Meetly AI — AI Assistant Quota Schema Migration (Hardened)
-- Migration: 20261016_meeting_ai_quotas.sql
-- Description: Meeting-scoped quota & reservation tables and atomic functions
--              for AI Assistant with fixed search_path, explicit role privileges,
--              concurrency row-locking, and idempotent refund tracking.
-- ============================================================================

-- 1. Ensure required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Create authoritative meeting_ai_quotas table
CREATE TABLE IF NOT EXISTS public.meeting_ai_quotas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL REFERENCES public.meetings(meeting_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    email VARCHAR(255) NULL,
    questions_used INTEGER NOT NULL DEFAULT 0 CHECK (questions_used >= 0 AND questions_used <= 10),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Enforce exact 1:1 participant quota per meeting
    CONSTRAINT uq_meeting_ai_quotas_meeting_user UNIQUE (meeting_id, user_id)
);

-- 3. Create meeting_ai_reservations table for idempotent question reservation/refund tracking
CREATE TABLE IF NOT EXISTS public.meeting_ai_reservations (
    reservation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL REFERENCES public.meetings(meeting_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL DEFAULT 'reserved' 
        CHECK (status IN ('reserved', 'completed', 'released')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Indexes for fast lookup and cascade cleanup
CREATE INDEX IF NOT EXISTS idx_meeting_ai_quotas_meeting_id ON public.meeting_ai_quotas(meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_ai_quotas_user_id ON public.meeting_ai_quotas(user_id);
CREATE INDEX IF NOT EXISTS idx_meeting_ai_reservations_meeting_id ON public.meeting_ai_reservations(meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_ai_reservations_user ON public.meeting_ai_reservations(meeting_id, user_id);

-- 5. Row Level Security (RLS) Policies on meeting_ai_quotas
ALTER TABLE public.meeting_ai_quotas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny direct inserts to meeting_ai_quotas" ON public.meeting_ai_quotas;
CREATE POLICY "Deny direct inserts to meeting_ai_quotas"
    ON public.meeting_ai_quotas FOR INSERT
    WITH CHECK (false);

DROP POLICY IF EXISTS "Deny direct updates to meeting_ai_quotas" ON public.meeting_ai_quotas;
CREATE POLICY "Deny direct updates to meeting_ai_quotas"
    ON public.meeting_ai_quotas FOR UPDATE
    USING (false);

DROP POLICY IF EXISTS "Deny direct deletes to meeting_ai_quotas" ON public.meeting_ai_quotas;
CREATE POLICY "Deny direct deletes to meeting_ai_quotas"
    ON public.meeting_ai_quotas FOR DELETE
    USING (false);

DROP POLICY IF EXISTS "Users can only select their own quota record" ON public.meeting_ai_quotas;
CREATE POLICY "Users can only select their own quota record"
    ON public.meeting_ai_quotas FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- 6. Row Level Security (RLS) Policies on meeting_ai_reservations
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

-- 7. Stored Function: Atomically Reserve Question Quota (Hardened with FOR SHARE lock and fixed search_path)
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
    v_max_questions CONSTANT INTEGER := 10; -- Strict hardcoded ceiling
BEGIN
    -- 1. Atomic shared row-level lock on meetings record
    -- Prevents competing meeting-end transactions from committing until reservation completes,
    -- and rejects requests if meeting is missing or already ended.
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

    -- 2. Check if this reservation ID already exists (idempotency guard)
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

    -- 3. Upsert initial quota row if not exists
    INSERT INTO public.meeting_ai_quotas (meeting_id, user_id, email, questions_used, created_at, updated_at)
    VALUES (p_meeting_id, p_user_id, LOWER(p_email), 0, NOW(), NOW())
    ON CONFLICT (meeting_id, user_id) 
    DO UPDATE SET 
        email = COALESCE(EXCLUDED.email, meeting_ai_quotas.email),
        updated_at = NOW();

    -- 4. Atomically check and increment IF questions_used < v_max_questions
    UPDATE public.meeting_ai_quotas
    SET 
        questions_used = questions_used + 1,
        updated_at = NOW()
    WHERE meeting_id = p_meeting_id 
      AND user_id = p_user_id
      AND questions_used < v_max_questions
    RETURNING questions_used INTO v_updated_used;

    IF v_updated_used IS NOT NULL THEN
        -- Record individual reservation
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
        -- Quota limit reached (all 10 questions consumed)
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

-- 8. Stored Function: Idempotently Release Question Reservation on Provider Failure
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
    -- 1. Check meeting existence and status
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

    -- 2. Reservation ID validation
    IF p_reservation_id IS NULL THEN
        RETURN QUERY SELECT false, 0, 0, 'Reservation ID required for release.'::TEXT;
        RETURN;
    END IF;

    -- 3. Lock and verify reservation row
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

    -- Idempotency check: if already released, do not decrement again
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

    -- Completed questions cannot be refunded
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

    -- 4. Mark reservation as released
    UPDATE public.meeting_ai_reservations
    SET status = 'released', updated_at = NOW()
    WHERE reservation_id = p_reservation_id;

    -- 5. Atomically decrement questions_used
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

-- 9. Stored Function: Mark Reservation Settled / Completed
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

-- 10. Stored Function: Read Quota State (Detects Nonexistent, Ended, and Active Meetings)
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
    -- Explicitly verify meeting existence in database
    SELECT meeting_status, is_deleted INTO v_status, v_deleted
    FROM public.meetings
    WHERE meeting_id = p_meeting_id;

    IF NOT FOUND THEN
        -- Nonexistent meeting: explicitly report meeting_exists = false, 0 remaining
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

-- 11. Stored Function: Delete Quotas and Reservations for Ended Meeting
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
    -- Exclusive row lock on meeting record to coordinate with in-flight reservations
    PERFORM 1 FROM public.meetings WHERE meeting_id = p_meeting_id FOR UPDATE;

    DELETE FROM public.meeting_ai_reservations
    WHERE meeting_id = p_meeting_id;

    DELETE FROM public.meeting_ai_quotas
    WHERE meeting_id = p_meeting_id;

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    RETURN v_deleted_count;
END;
$$;

-- 12. Security Privileges: Revoke from untrusted roles, Grant to trusted service role
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
