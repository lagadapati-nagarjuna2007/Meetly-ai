-- ============================================================================
-- Meetly AI Screen Recording Schema Migration
-- Migration: 20261011_screen_recording_schema.sql
-- Status: PREPARED FOR REVIEW (DO NOT EXECUTE AGAINST PRODUCTION WITHOUT APPROVAL)
-- ============================================================================

-- 1. Ensure extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Enhance meetings table for safe deletion coordination
ALTER TABLE IF EXISTS meetings 
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS has_recording BOOLEAN NOT NULL DEFAULT false;

-- 3. Create authoritative recordings table
CREATE TABLE IF NOT EXISTS recordings (
    recording_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID NOT NULL REFERENCES meetings(meeting_id) ON DELETE RESTRICT,
    meeting_code VARCHAR(16) NOT NULL,
    host_id UUID NOT NULL REFERENCES users(id),
    recorded_by UUID NOT NULL REFERENCES users(id),
    b2_key TEXT NOT NULL UNIQUE,
    b2_upload_id TEXT NULL,
    mime_type VARCHAR(64) NOT NULL DEFAULT 'video/webm',
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    file_size_bytes BIGINT NOT NULL DEFAULT 0,

    -- Authoritative Server Lifecycle Status
    status VARCHAR(32) NOT NULL DEFAULT 'starting'
        CHECK (status IN ('starting', 'recording', 'finalizing', 'ready', 'failed', 'pending_deletion', 'purged')),

    -- Distinct Storage Cleanup Status
    cleanup_status VARCHAR(32) NOT NULL DEFAULT 'none'
        CHECK (cleanup_status IN ('none', 'pending_cleanup', 'cleaning', 'cleaned', 'unresolved_error')),

    -- Distinct Durable B2 Mutation Tracking
    b2_operation_state VARCHAR(32) NOT NULL DEFAULT 'idle'
        CHECK (b2_operation_state IN ('idle', 'in_flight', 'settled', 'unresolved')),
    last_b2_operation VARCHAR(32) NULL
        CHECK (last_b2_operation IN ('create_multipart', 'complete_multipart', 'abort_multipart', 'delete_versions', NULL)),
    operation_id UUID NULL,
    operation_started_at TIMESTAMPTZ NULL,

    -- Optimistic Concurrency & Worker Claim Leasing
    fencing_token INTEGER NOT NULL DEFAULT 1,
    operation_claim_token UUID NULL,
    operation_claimed_at TIMESTAMPTZ NULL,

    failure_reason TEXT NULL,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ NULL,
    expires_at TIMESTAMPTZ NULL
);

-- 4. Create Indexes
CREATE INDEX IF NOT EXISTS idx_recordings_meeting_id ON recordings(meeting_id);
CREATE INDEX IF NOT EXISTS idx_recordings_host_id ON recordings(host_id);
CREATE INDEX IF NOT EXISTS idx_recordings_retention ON recordings(status, expires_at) 
    WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS idx_recordings_cleanup ON recordings(cleanup_status, operation_claimed_at) 
    WHERE cleanup_status IN ('pending_cleanup', 'cleaning', 'unresolved_error');
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_recording_per_meeting ON recordings(meeting_id)
    WHERE status IN ('starting', 'recording', 'finalizing');

-- 5. Row Level Security
ALTER TABLE recordings ENABLE ROW LEVEL SECURITY;

-- Deny direct public/anon access
DROP POLICY IF EXISTS "Deny anon access on recordings" ON recordings;
CREATE POLICY "Deny anon access on recordings" ON recordings
    FOR ALL
    TO anon
    USING (false);

-- Grant service_role full control (Express backend accesses Supabase via service role)
DROP POLICY IF EXISTS "Service role full access on recordings" ON recordings;
CREATE POLICY "Service role full access on recordings" ON recordings
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ============================================================================
-- 6. Guarded RPC Functions for Atomic Lifecycle Transitions
-- ============================================================================

-- RPC: Atomically initiate recording session
CREATE OR REPLACE FUNCTION rpc_initiate_recording_session(
    p_meeting_id UUID,
    p_meeting_code VARCHAR,
    p_host_id UUID,
    p_recorded_by UUID,
    p_b2_key TEXT,
    p_mime_type VARCHAR,
    p_operation_id UUID
)
RETURNS TABLE (
    recording_id UUID,
    fencing_token INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_recording_id UUID;
    v_fencing_token INTEGER := 1;
BEGIN
    -- Database-level concurrency lock: serialize concurrent starts for this meeting
    PERFORM pg_advisory_xact_lock(hashtext('recording_meeting_lock:' || p_meeting_id::text));
    PERFORM 1 FROM meetings WHERE meeting_id = p_meeting_id FOR UPDATE;

    -- Ensure no other recording is in active starting/recording/finalizing state for this meeting
    IF EXISTS (
        SELECT 1 FROM recordings 
        WHERE meeting_id = p_meeting_id 
          AND status IN ('starting', 'recording', 'finalizing')
    ) THEN
        RAISE EXCEPTION 'A recording session is already active or finalizing for this meeting.';
    END IF;

    INSERT INTO recordings (
        meeting_id,
        meeting_code,
        host_id,
        recorded_by,
        b2_key,
        mime_type,
        status,
        cleanup_status,
        b2_operation_state,
        last_b2_operation,
        operation_id,
        operation_started_at,
        fencing_token,
        created_at
    ) VALUES (
        p_meeting_id,
        p_meeting_code,
        p_host_id,
        p_recorded_by,
        p_b2_key,
        COALESCE(p_mime_type, 'video/webm'),
        'starting',
        'none',
        'in_flight',
        'create_multipart',
        p_operation_id,
        NOW(),
        v_fencing_token,
        NOW()
    )
    RETURNING recordings.recording_id INTO v_recording_id;

    RETURN QUERY SELECT v_recording_id, v_fencing_token;
END;
$$;

-- RPC: Resolve CreateMultipartUpload result
CREATE OR REPLACE FUNCTION rpc_resolve_create_multipart(
    p_recording_id UUID,
    p_fencing_token INTEGER,
    p_b2_upload_id TEXT,
    p_success BOOLEAN,
    p_error TEXT
)
RETURNS TABLE (
    updated BOOLEAN,
    new_fencing_token INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_current_token INTEGER;
BEGIN
    SELECT fencing_token INTO v_current_token
    FROM recordings
    WHERE recording_id = p_recording_id AND status = 'starting';

    IF v_current_token IS NULL OR v_current_token != p_fencing_token THEN
        RETURN QUERY SELECT false, 0;
        RETURN;
    END IF;

    IF p_success THEN
        UPDATE recordings SET
            b2_upload_id = p_b2_upload_id,
            b2_operation_state = 'settled',
            fencing_token = v_current_token + 1
        WHERE recording_id = p_recording_id;
    ELSE
        -- Preserve unresolved operation state and mark unresolved_error
        UPDATE recordings SET
            status = 'failed',
            failure_reason = p_error,
            cleanup_status = 'unresolved_error',
            b2_operation_state = 'unresolved',
            fencing_token = v_current_token + 1
        WHERE recording_id = p_recording_id;
    END IF;

    RETURN QUERY SELECT true, v_current_token + 1;
END;
$$;

-- RPC: Finalize Ready Recording (Guarded by size cap 2,000,000,000 bytes)
CREATE OR REPLACE FUNCTION rpc_finalize_ready_recording(
    p_recording_id UUID,
    p_fencing_token INTEGER,
    p_verified_size BIGINT,
    p_duration_seconds INTEGER,
    p_mime_type VARCHAR
)
RETURNS TABLE (
    updated BOOLEAN,
    new_fencing_token INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_current_token INTEGER;
    v_meeting_id UUID;
BEGIN
    SELECT fencing_token, meeting_id INTO v_current_token, v_meeting_id
    FROM recordings
    WHERE recording_id = p_recording_id AND status = 'finalizing';

    IF v_current_token IS NULL OR v_current_token != p_fencing_token THEN
        RETURN QUERY SELECT false, 0;
        RETURN;
    END IF;

    -- Strict hard limit enforcement: max 2,000,000,000 bytes
    IF p_verified_size > 2000000000 THEN
        UPDATE recordings SET
            status = 'failed',
            failure_reason = 'Verified file size exceeded 2,000,000,000 bytes limit.',
            cleanup_status = 'pending_cleanup',
            b2_operation_state = 'settled',
            file_size_bytes = p_verified_size,
            duration_seconds = p_duration_seconds,
            fencing_token = v_current_token + 1
        WHERE recording_id = p_recording_id;

        RETURN QUERY SELECT false, v_current_token + 1;
        RETURN;
    END IF;

    -- Normal success finalization
    UPDATE recordings SET
        status = 'ready',
        file_size_bytes = p_verified_size,
        duration_seconds = p_duration_seconds,
        mime_type = COALESCE(p_mime_type, mime_type),
        completed_at = NOW(),
        expires_at = NOW() + INTERVAL '30 days',
        b2_upload_id = NULL,
        b2_operation_state = 'settled',
        fencing_token = v_current_token + 1
    WHERE recording_id = p_recording_id;

    -- Mark parent meeting as having a recording
    UPDATE meetings SET has_recording = true WHERE meeting_id = v_meeting_id;

    RETURN QUERY SELECT true, v_current_token + 1;
END;
$$;

-- RPC: Atomically Claim Cleanup Batch with Durable Leases
-- Strictly excludes unresolved or in-flight operations; elapsed time cannot authorize cleanup of unresolved recordings
CREATE OR REPLACE FUNCTION rpc_claim_cleanup_batch(
    p_claim_token UUID,
    p_batch_size INTEGER DEFAULT 10,
    p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (
    recording_id UUID,
    meeting_id UUID,
    b2_key TEXT,
    b2_upload_id TEXT,
    fencing_token INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY
    WITH candidate_rows AS (
        SELECT r.recording_id
        FROM recordings r
        WHERE (
            -- 1. Normal retention expiration for ready recordings that have settled B2 state
            (r.status = 'ready' AND r.expires_at < NOW() AND r.cleanup_status = 'none' AND r.b2_operation_state = 'settled')
            -- 2. Explicitly queued deletions and eligible failed recordings (e.g. oversized) that have settled B2 state
            OR (r.status IN ('pending_deletion', 'failed') AND r.cleanup_status = 'pending_cleanup' AND r.b2_operation_state = 'settled')
            -- 3. Resuming crashed worker leases where B2 state is settled and lease has expired
            OR (r.cleanup_status = 'cleaning' AND r.b2_operation_state = 'settled' AND r.operation_claimed_at < NOW() - (p_lease_seconds || ' seconds')::INTERVAL)
        )
        -- Worker lease is either unclaimed or expired
        AND (r.operation_claimed_at IS NULL OR r.operation_claimed_at < NOW() - (p_lease_seconds || ' seconds')::INTERVAL)
        -- STRICT GUARD: Never authorize cleanup if any unresolved or in-flight B2 operation exists
        AND r.b2_operation_state NOT IN ('in_flight', 'unresolved')
        AND r.cleanup_status != 'unresolved_error'
        ORDER BY r.created_at ASC
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED
    )
    UPDATE recordings rec
    SET 
        cleanup_status = 'cleaning',
        operation_claim_token = p_claim_token,
        operation_claimed_at = NOW(),
        fencing_token = rec.fencing_token + 1
    FROM candidate_rows c
    WHERE rec.recording_id = c.recording_id
    RETURNING rec.recording_id, rec.meeting_id, rec.b2_key, rec.b2_upload_id, rec.fencing_token;
END;
$$;

-- RPC: Guarded Atomic Purge & Hard Deletion of Child and Parent
CREATE OR REPLACE FUNCTION rpc_purge_and_hard_delete_meeting(
    p_meeting_id UUID,
    p_recording_id UUID,
    p_fencing_token INTEGER,
    p_claim_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_rec_token INTEGER;
BEGIN
    -- Verify child recording claim & token, strictly requiring storage cleanup settled and confirmed
    SELECT fencing_token INTO v_rec_token
    FROM recordings
    WHERE recording_id = p_recording_id 
      AND meeting_id = p_meeting_id
      AND operation_claim_token = p_claim_token
      AND cleanup_status = 'cleaned'
      AND b2_operation_state = 'settled';

    IF v_rec_token IS NULL OR v_rec_token != p_fencing_token THEN
        RETURN false;
    END IF;

    -- 1. Delete child recording
    DELETE FROM recordings WHERE recording_id = p_recording_id;

    -- 2. If no other recordings remain for this meeting, delete cascading security & meeting rows
    IF NOT EXISTS (SELECT 1 FROM recordings WHERE meeting_id = p_meeting_id) THEN
        DELETE FROM meeting_device_bans WHERE meeting_code IN (SELECT meeting_code FROM meetings WHERE meeting_id = p_meeting_id);
        DELETE FROM meeting_join_requests WHERE meeting_code IN (SELECT meeting_code FROM meetings WHERE meeting_id = p_meeting_id);
        DELETE FROM participants WHERE meeting_id = p_meeting_id;
        DELETE FROM meeting_attendance WHERE meeting_id = p_meeting_id;
        DELETE FROM meetings WHERE meeting_id = p_meeting_id;
    END IF;

    RETURN true;
END;
$$;

-- ============================================================================
-- 7. Secure RPC Execution Permissions (Restrict direct public/anon RPC calls)
-- ============================================================================
REVOKE EXECUTE ON FUNCTION rpc_initiate_recording_session(UUID, VARCHAR, UUID, UUID, TEXT, VARCHAR, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION rpc_resolve_create_multipart(UUID, INTEGER, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION rpc_finalize_ready_recording(UUID, INTEGER, BIGINT, INTEGER, VARCHAR) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION rpc_claim_cleanup_batch(UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION rpc_purge_and_hard_delete_meeting(UUID, UUID, INTEGER, UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION rpc_initiate_recording_session(UUID, VARCHAR, UUID, UUID, TEXT, VARCHAR, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION rpc_resolve_create_multipart(UUID, INTEGER, TEXT, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION rpc_finalize_ready_recording(UUID, INTEGER, BIGINT, INTEGER, VARCHAR) TO service_role;
GRANT EXECUTE ON FUNCTION rpc_claim_cleanup_batch(UUID, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION rpc_purge_and_hard_delete_meeting(UUID, UUID, INTEGER, UUID) TO service_role;

