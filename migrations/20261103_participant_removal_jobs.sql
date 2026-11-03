-- ============================================================================
-- Migration: 20261103_participant_removal_jobs.sql
-- Description: Durable Supabase PostgreSQL Queue for Cloudflare Participant Revocation
--
-- Objective:
-- 1. Create public.participant_removal_jobs table to durably persist and track
--    participant removal operations across Cloudflare outages and Render restarts.
-- 2. Participant Validation: Check FOUND immediately after row lock; reject nonexistent participants.
-- 3. Session-Based Idempotency: Unique session_key ensures repeated removals for the
--    same session are idempotent, while new participant sessions create fresh jobs
--    and preserve completed jobs as historical audit logs.
-- 4. Worker Lease Fencing: lease_token UUID prevents expired/stale workers from
--    overwriting newer worker claims or completions.
-- 5. Foreign-key protection: meeting_id and user_id allow NULL and use ON DELETE SET NULL
--    so meeting/user cleanup never deletes unresolved or auditable revocation jobs.
-- 6. Strict input validation across all batch sizes, lease durations, retry delays, and attempts.
-- 7. Idempotent DDL support for fresh databases and existing development databases.
-- 8. Row Level Security (RLS) restricted exclusively to service_role.
-- 9. PostgreSQL functions with SECURITY DEFINER and SET search_path = pg_catalog, public, pg_temp.
-- ============================================================================

-- 1. Ensure required extensions and schema security
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Harden public schema against untrusted object creation
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;

-- 2. Create authoritative participant_removal_jobs table (fresh install)
CREATE TABLE IF NOT EXISTS public.participant_removal_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NULL REFERENCES public.meetings(meeting_id) ON DELETE SET NULL,
    user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
    cloudflare_meeting_id TEXT NULL,
    cloudflare_participant_id TEXT NULL,
    session_key TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending' 
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error TEXT NULL,
    lease_expires_at TIMESTAMPTZ NULL,
    lease_token UUID NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ NULL
);

-- 3. Idempotent Migration Block for existing development databases
DO $$
DECLARE
    v_fk_meeting TEXT;
    v_fk_user TEXT;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'participant_removal_jobs'
    ) THEN
        -- 3.0. Lock table in EXCLUSIVE mode to prevent concurrent writes during key migration & deduplication
        LOCK TABLE public.participant_removal_jobs IN EXCLUSIVE MODE;

        -- Drop existing unique index on session_key if present, so that updating legacy unscoped keys
        -- to canonical keys does not collide with existing already-scoped keys before deduplication completes.
        -- Recreated in step 4 below after deduplication.
        DROP INDEX IF EXISTS public.uq_participant_removal_jobs_session_key;

        -- 3.1. Add session_key if missing
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_schema = 'public' 
              AND table_name = 'participant_removal_jobs' 
              AND column_name = 'session_key'
        ) THEN
            ALTER TABLE public.participant_removal_jobs ADD COLUMN session_key TEXT;
        END IF;

        -- 3.1. Migrate both NULL and existing non-null legacy session_key values to canonical format.
        -- Uses the exact same participant_id identifier as runtime create_participant_removal_job_tx.
        -- Detects duplicate canonical keys before creating the unique index:
        -- Active jobs (pending/processing) retain the canonical key; historical duplicate jobs are appended with ':dup:<id>'.
        -- Preserves every existing job ID, status, attempts, retry time, lease, error, and audit timestamp. Zero rows deleted.
        WITH ranked_jobs AS (
            SELECT 
                j.id,
                CASE
                    WHEN j.cloudflare_participant_id IS NOT NULL AND length(trim(j.cloudflare_participant_id)) > 0 THEN
                        'cf:' || COALESCE(NULLIF(trim(j.cloudflare_meeting_id), ''), COALESCE(j.meeting_id::text, 'none')) || ':' || trim(j.cloudflare_participant_id)
                    ELSE
                        'part:' || COALESCE(j.meeting_id::text, 'none') || ':' || COALESCE(p.participant_id::text, j.user_id::text, j.id::text)
                END AS canonical_key,
                ROW_NUMBER() OVER (
                    PARTITION BY 
                        CASE
                            WHEN j.cloudflare_participant_id IS NOT NULL AND length(trim(j.cloudflare_participant_id)) > 0 THEN
                                'cf:' || COALESCE(NULLIF(trim(j.cloudflare_meeting_id), ''), COALESCE(j.meeting_id::text, 'none')) || ':' || trim(j.cloudflare_participant_id)
                            ELSE
                                'part:' || COALESCE(j.meeting_id::text, 'none') || ':' || COALESCE(p.participant_id::text, j.user_id::text, j.id::text)
                        END
                    ORDER BY 
                        CASE 
                            WHEN j.status IN ('pending', 'processing') THEN 1
                            WHEN j.status = 'failed' THEN 2
                            ELSE 3
                        END ASC,
                        j.updated_at DESC,
                        j.created_at DESC,
                        j.id DESC
                ) AS rn
            FROM public.participant_removal_jobs j
            LEFT JOIN (
                SELECT DISTINCT ON (meeting_id, user_id) meeting_id, user_id, participant_id
                FROM public.participants
                ORDER BY meeting_id, user_id, joined_at DESC
            ) p ON j.meeting_id = p.meeting_id AND j.user_id = p.user_id
        )
        UPDATE public.participant_removal_jobs u
        SET session_key = CASE 
            WHEN r.rn = 1 THEN r.canonical_key
            ELSE r.canonical_key || ':dup:' || r.id::text
        END
        FROM ranked_jobs r
        WHERE u.id = r.id;

        ALTER TABLE public.participant_removal_jobs ALTER COLUMN session_key SET NOT NULL;

        -- 3.2. Add lease_token if missing
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_schema = 'public' 
              AND table_name = 'participant_removal_jobs' 
              AND column_name = 'lease_token'
        ) THEN
            ALTER TABLE public.participant_removal_jobs ADD COLUMN lease_token UUID;
        END IF;

        -- 3.3. Allow NULL on meeting_id and user_id
        ALTER TABLE public.participant_removal_jobs ALTER COLUMN meeting_id DROP NOT NULL;
        ALTER TABLE public.participant_removal_jobs ALTER COLUMN user_id DROP NOT NULL;

        -- 3.4. Drop and replace foreign key on meeting_id with ON DELETE SET NULL
        SELECT tc.constraint_name INTO v_fk_meeting
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu 
          ON tc.constraint_name = kcu.constraint_name 
         AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = 'public'
          AND tc.table_name = 'participant_removal_jobs'
          AND kcu.column_name = 'meeting_id'
        LIMIT 1;

        IF v_fk_meeting IS NOT NULL THEN
            EXECUTE 'ALTER TABLE public.participant_removal_jobs DROP CONSTRAINT ' || quote_ident(v_fk_meeting);
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE table_schema = 'public'
              AND table_name = 'participant_removal_jobs'
              AND constraint_name = 'fk_participant_removal_jobs_meeting_id'
        ) THEN
            ALTER TABLE public.participant_removal_jobs 
                ADD CONSTRAINT fk_participant_removal_jobs_meeting_id 
                FOREIGN KEY (meeting_id) REFERENCES public.meetings(meeting_id) ON DELETE SET NULL;
        END IF;

        -- 3.5. Drop and replace foreign key on user_id with ON DELETE SET NULL
        SELECT tc.constraint_name INTO v_fk_user
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu 
          ON tc.constraint_name = kcu.constraint_name 
         AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = 'public'
          AND tc.table_name = 'participant_removal_jobs'
          AND kcu.column_name = 'user_id'
        LIMIT 1;

        IF v_fk_user IS NOT NULL THEN
            EXECUTE 'ALTER TABLE public.participant_removal_jobs DROP CONSTRAINT ' || quote_ident(v_fk_user);
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE table_schema = 'public'
              AND table_name = 'participant_removal_jobs'
              AND constraint_name = 'fk_participant_removal_jobs_user_id'
        ) THEN
            ALTER TABLE public.participant_removal_jobs 
                ADD CONSTRAINT fk_participant_removal_jobs_user_id 
                FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
        END IF;

        -- 3.6. Drop legacy unique constraints and partial indexes
        IF EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE table_schema = 'public'
              AND table_name = 'participant_removal_jobs'
              AND constraint_name = 'uq_participant_removal_jobs_meeting_user'
        ) THEN
            ALTER TABLE public.participant_removal_jobs 
                DROP CONSTRAINT uq_participant_removal_jobs_meeting_user;
        END IF;

        DROP INDEX IF EXISTS public.uq_participant_removal_jobs_active;

        -- 3.7. Recreate the unique index IMMEDIATELY while still holding the EXCLUSIVE table lock!
        -- This guarantees that the table lock is NOT released until after the unique index is restored,
        -- preventing any concurrent transaction from inserting duplicate keys during or immediately after backfill.
        -- Atomic under any execution method (including autocommit or statement-by-statement runners).
        EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_participant_removal_jobs_session_key ON public.participant_removal_jobs (session_key)';
    END IF;
END $$;

-- 4. Session-Based Unique Index
CREATE UNIQUE INDEX IF NOT EXISTS uq_participant_removal_jobs_session_key 
    ON public.participant_removal_jobs (session_key);

-- 5. Query, Lease, and Worker Indexes
CREATE INDEX IF NOT EXISTS idx_participant_removal_jobs_pending 
    ON public.participant_removal_jobs (status, next_retry_at, lease_expires_at)
    WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_participant_removal_jobs_meeting_id 
    ON public.participant_removal_jobs (meeting_id);

CREATE INDEX IF NOT EXISTS idx_participant_removal_jobs_user_id 
    ON public.participant_removal_jobs (user_id);

CREATE INDEX IF NOT EXISTS idx_participant_removal_jobs_lease_token
    ON public.participant_removal_jobs (lease_token)
    WHERE lease_token IS NOT NULL;

-- 6. Row Level Security (RLS) Hardening
ALTER TABLE public.participant_removal_jobs ENABLE ROW LEVEL SECURITY;

-- Revoke all permissions from public, anon, and authenticated users
REVOKE ALL ON TABLE public.participant_removal_jobs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.participant_removal_jobs TO service_role, postgres;

-- Exclusive RLS Policy for trusted service role
DROP POLICY IF EXISTS service_role_all_participant_removal_jobs ON public.participant_removal_jobs;
CREATE POLICY service_role_all_participant_removal_jobs ON public.participant_removal_jobs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- 7. RPC 1: create_participant_removal_job_tx
-- Atomically validates participant existence, creates/upserts removal job by session_key,
-- and marks participant as removed in DB
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_participant_removal_job_tx(
    p_meeting_id UUID,
    p_user_id UUID,
    p_cloudflare_meeting_id TEXT DEFAULT NULL,
    p_cloudflare_participant_id TEXT DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    meeting_id UUID,
    user_id UUID,
    cloudflare_meeting_id TEXT,
    cloudflare_participant_id TEXT,
    session_key TEXT,
    status VARCHAR(32),
    attempts INTEGER,
    next_retry_at TIMESTAMPTZ,
    last_error TEXT,
    lease_expires_at TIMESTAMPTZ,
    lease_token UUID,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    participant_status VARCHAR(50)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_job_id UUID;
    v_part_id UUID;
    v_part_status VARCHAR(50);
    v_db_cf_part_id TEXT;
    v_db_cf_meeting_id TEXT;
    v_effective_cf_meeting_id TEXT;
    v_effective_cf_participant_id TEXT;
    v_session_key TEXT;
BEGIN
    -- Input validation
    IF p_meeting_id IS NULL THEN
        RAISE EXCEPTION 'Meeting ID is required';
    END IF;
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'User ID is required';
    END IF;

    -- 1. Lock participant row to ensure atomic state transition
    SELECT p.participant_id, p.participant_status, p.cloudflare_participant_id
    INTO v_part_id, v_part_status, v_db_cf_part_id
    FROM public.participants p
    WHERE p.meeting_id = p_meeting_id
      AND p.user_id = p_user_id
    FOR UPDATE;

    -- PARTICIPANT VALIDATION: Check FOUND immediately and reject nonexistent participants
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Participant not found in meeting';
    END IF;

    -- 2. Mark participant as removed (preserving convention; safe for repeated removals)
    UPDATE public.participants p
    SET participant_status = 'removed',
        left_at = COALESCE(p.left_at, now())
    WHERE p.meeting_id = p_meeting_id
      AND p.user_id = p_user_id;

    -- 3. Determine effective Cloudflare meeting & participant session IDs
    SELECT m.cloudflare_meeting_id INTO v_db_cf_meeting_id
    FROM public.meetings m
    WHERE m.meeting_id = p_meeting_id;

    v_effective_cf_meeting_id := COALESCE(NULLIF(trim(p_cloudflare_meeting_id), ''), v_db_cf_meeting_id, p_meeting_id::text);
    v_effective_cf_participant_id := COALESCE(NULLIF(trim(p_cloudflare_participant_id), ''), v_db_cf_part_id);

    -- 4. Establish stable session identifier:
    --    Includes both Cloudflare meeting ID and participant ID.
    --    Fallback keys are scoped to meeting and participant record.
    IF v_effective_cf_participant_id IS NOT NULL AND v_effective_cf_participant_id != '' THEN
        v_session_key := 'cf:' || v_effective_cf_meeting_id || ':' || v_effective_cf_participant_id;
    ELSE
        -- Fallback scoped to meeting and participant record
        v_session_key := 'part:' || p_meeting_id::text || ':' || v_part_id::text;
    END IF;

    -- 5. Insert or update the removal job idempotently based on session_key.
    --    DUPLICATE REQUEST HANDLING:
    --    - Make duplicate removal requests idempotent without changing existing job state.
    --    - Never reset a processing job's lease.
    --    - Never bypass an existing next_retry_at.
    --    - Never automatically reopen a failed job through a duplicate request.
    --    - Keep explicit manual retry as the only mechanism for reopening failed jobs.
    --    - Preserve completed records.
    INSERT INTO public.participant_removal_jobs (
        meeting_id,
        user_id,
        cloudflare_meeting_id,
        cloudflare_participant_id,
        session_key,
        status,
        attempts,
        next_retry_at,
        lease_expires_at,
        lease_token,
        created_at,
        updated_at
    )
    VALUES (
        p_meeting_id,
        p_user_id,
        v_effective_cf_meeting_id,
        v_effective_cf_participant_id,
        v_session_key,
        'pending',
        0,
        now(),
        NULL,
        NULL,
        now(),
        now()
    )
    ON CONFLICT (session_key) DO UPDATE SET
        updated_at = public.participant_removal_jobs.updated_at
    RETURNING public.participant_removal_jobs.id INTO v_job_id;

    RETURN QUERY
    SELECT 
        j.id,
        j.meeting_id,
        j.user_id,
        j.cloudflare_meeting_id,
        j.cloudflare_participant_id,
        j.session_key,
        j.status,
        j.attempts,
        j.next_retry_at,
        j.last_error,
        j.lease_expires_at,
        j.lease_token,
        j.created_at,
        j.updated_at,
        j.completed_at,
        'removed'::VARCHAR(50) AS participant_status
    FROM public.participant_removal_jobs j
    WHERE j.id = v_job_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. RPC 2: claim_participant_removal_jobs_tx
-- Claims a batch of eligible jobs using FOR UPDATE SKIP LOCKED with lease_token fencing
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_participant_removal_jobs_tx(
    p_batch_size INTEGER DEFAULT 10,
    p_lease_seconds INTEGER DEFAULT 60
)
RETURNS TABLE (
    id UUID,
    meeting_id UUID,
    user_id UUID,
    cloudflare_meeting_id TEXT,
    cloudflare_participant_id TEXT,
    session_key TEXT,
    status VARCHAR(32),
    attempts INTEGER,
    next_retry_at TIMESTAMPTZ,
    last_error TEXT,
    lease_expires_at TIMESTAMPTZ,
    lease_token UUID,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    meeting_code VARCHAR(255),
    room_name VARCHAR(255)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    -- Input validation
    IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 100 THEN
        RAISE EXCEPTION 'Batch size must be between 1 and 100';
    END IF;
    IF p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN
        RAISE EXCEPTION 'Lease duration must be between 1 and 3600 seconds';
    END IF;

    RETURN QUERY
    WITH eligible_jobs AS (
        SELECT j.id
        FROM public.participant_removal_jobs j
        WHERE (
            (j.status = 'pending' AND j.next_retry_at <= now())
            OR
            (j.status = 'processing' AND j.lease_expires_at <= now())
        )
        ORDER BY j.next_retry_at ASC
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED
    ),
    claimed_jobs AS (
        UPDATE public.participant_removal_jobs j
        SET status = 'processing',
            lease_expires_at = now() + (p_lease_seconds || ' seconds')::interval,
            lease_token = gen_random_uuid(),  -- Fresh lease token for this claim
            attempts = j.attempts + 1,
            updated_at = now()
        FROM eligible_jobs e
        WHERE j.id = e.id
        RETURNING j.*
    )
    SELECT 
        c.id,
        c.meeting_id,
        c.user_id,
        c.cloudflare_meeting_id,
        c.cloudflare_participant_id,
        c.session_key,
        c.status,
        c.attempts,
        c.next_retry_at,
        c.last_error,
        c.lease_expires_at,
        c.lease_token,
        c.created_at,
        c.updated_at,
        c.completed_at,
        m.meeting_code,
        m.room_name
    FROM claimed_jobs c
    LEFT JOIN public.meetings m ON m.meeting_id = c.meeting_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. RPC 3: complete_participant_removal_job_tx
-- Marks a removal job as completed; fences completion by lease_token
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_participant_removal_job_tx(
    p_job_id UUID,
    p_lease_token UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF p_job_id IS NULL THEN
        RAISE EXCEPTION 'Job ID is required';
    END IF;

    IF p_lease_token IS NOT NULL THEN
        -- Worker completion: requires matching lease token
        UPDATE public.participant_removal_jobs
        SET status = 'completed',
            completed_at = now(),
            lease_expires_at = NULL,
            lease_token = NULL,
            last_error = NULL,
            updated_at = now()
        WHERE id = p_job_id
          AND lease_token = p_lease_token;
    ELSE
        -- Immediate caller completion: allowed only if job is not leased by a worker
        UPDATE public.participant_removal_jobs
        SET status = 'completed',
            completed_at = now(),
            lease_expires_at = NULL,
            lease_token = NULL,
            last_error = NULL,
            updated_at = now()
        WHERE id = p_job_id
          AND (lease_token IS NULL OR status != 'processing');
    END IF;

    RETURN FOUND;
END;
$$;

-- ----------------------------------------------------------------------------
-- 10. RPC 4: schedule_participant_removal_retry_tx
-- Schedules bounded retry with backoff, or marks job failed; fences retry by lease_token
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.schedule_participant_removal_retry_tx(
    p_job_id UUID,
    p_error_message TEXT,
    p_backoff_seconds INTEGER DEFAULT 30,
    p_max_attempts INTEGER DEFAULT 5,
    p_lease_token UUID DEFAULT NULL
)
RETURNS VARCHAR(32)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_new_status VARCHAR(32);
BEGIN
    -- Input validation
    IF p_job_id IS NULL THEN
        RAISE EXCEPTION 'Job ID is required';
    END IF;
    IF p_backoff_seconds IS NULL OR p_backoff_seconds < 0 OR p_backoff_seconds > 86400 THEN
        RAISE EXCEPTION 'Backoff duration must be between 0 and 86400 seconds';
    END IF;
    IF p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 100 THEN
        RAISE EXCEPTION 'Max attempts must be between 1 and 100';
    END IF;

    IF p_lease_token IS NOT NULL THEN
        -- Worker retry: requires matching lease token
        UPDATE public.participant_removal_jobs
        SET status = CASE 
                WHEN attempts >= p_max_attempts THEN 'failed' 
                ELSE 'pending' 
            END,
            last_error = p_error_message,
            next_retry_at = now() + (p_backoff_seconds || ' seconds')::interval,
            lease_expires_at = NULL,
            lease_token = NULL,
            updated_at = now()
        WHERE id = p_job_id
          AND lease_token = p_lease_token
        RETURNING status INTO v_new_status;
    ELSE
        -- Immediate failure retry: allowed only if job is not leased by a worker
        UPDATE public.participant_removal_jobs
        SET status = CASE 
                WHEN attempts >= p_max_attempts THEN 'failed' 
                ELSE 'pending' 
            END,
            last_error = p_error_message,
            next_retry_at = now() + (p_backoff_seconds || ' seconds')::interval,
            lease_expires_at = NULL,
            lease_token = NULL,
            updated_at = now()
        WHERE id = p_job_id
          AND (lease_token IS NULL OR status != 'processing')
        RETURNING status INTO v_new_status;
    END IF;

    RETURN v_new_status;
END;
$$;

-- ----------------------------------------------------------------------------
-- 11. RPC 5: recover_expired_participant_removal_leases_tx
-- Recovers stale processing leases after server crashes and clears lease_token
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recover_expired_participant_removal_leases_tx(
    p_batch_size INTEGER DEFAULT 50
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_recovered_count INTEGER := 0;
BEGIN
    -- Input validation
    IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 500 THEN
        RAISE EXCEPTION 'Batch size must be between 1 and 500';
    END IF;

    WITH expired_jobs AS (
        SELECT id
        FROM public.participant_removal_jobs
        WHERE status = 'processing'
          AND lease_expires_at <= now()
        ORDER BY lease_expires_at ASC
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED
    ),
    reset_jobs AS (
        UPDATE public.participant_removal_jobs j
        SET status = 'pending',
            lease_expires_at = NULL,
            lease_token = NULL,
            updated_at = now()
        FROM expired_jobs e
        WHERE j.id = e.id
        RETURNING j.id
    )
    SELECT count(*) INTO v_recovered_count FROM reset_jobs;

    RETURN v_recovered_count;
END;
$$;

-- ----------------------------------------------------------------------------
-- 12. Explicit Privilege Grants for Stored Procedures
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.create_participant_removal_job_tx FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_participant_removal_job_tx TO service_role, postgres;

REVOKE EXECUTE ON FUNCTION public.claim_participant_removal_jobs_tx FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_participant_removal_jobs_tx TO service_role, postgres;

REVOKE EXECUTE ON FUNCTION public.complete_participant_removal_job_tx FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_participant_removal_job_tx TO service_role, postgres;

REVOKE EXECUTE ON FUNCTION public.schedule_participant_removal_retry_tx FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_participant_removal_retry_tx TO service_role, postgres;

REVOKE EXECUTE ON FUNCTION public.recover_expired_participant_removal_leases_tx FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_expired_participant_removal_leases_tx TO service_role, postgres;
