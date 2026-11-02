-- ============================================================================
-- Migration: 20261101_harden_waiting_room_admission_tx.sql
-- Description: Hardened Admission & Device-Ban Concurrency Protocol
--
-- 1. Per-User Admission Advisory Lock:
--    Key: (hashtext('meetly-admission-user:' || v_clean_code), hashtext(p_user_id::text))
--    Acquired immediately after meeting FOR SHARE lock across all six transactional operations:
--    - create_join_request_tx
--    - accept_join_request_tx
--    - finalize_participant_admission_tx
--    - auto_admit_participant_tx
--    - reject_join_request_tx
--    - ban_device_tx (serializes target user reads/cleanup against concurrent user actions)
--    Eliminates concurrent phantom-row insertions and uncoordinated state transitions.
-- 2. Complete Lock Order Hierarchy:
--    Step 1: Meeting row lock (FOR SHARE)
--    Step 2: Per-user admission advisory lock (meeting_code, user_id)
--    Step 3: Device-fingerprint advisory lock(s) in deterministic sorted order
--    Step 4: meeting_join_requests row locks (ORDER BY id FOR UPDATE)
--    Step 5: participants row locks (ORDER BY participant_id FOR UPDATE)
-- 3. Dedicated ban_device_tx Hierarchy:
--    Meeting FOR SHARE -> Target user advisory lock -> Sorted fingerprint advisory locks ->
--    All affected request rows (ORDER BY id FOR UPDATE) -> All affected participant rows (ORDER BY participant_id FOR UPDATE)
-- 4. Explicit participant admission lifecycle: pending -> enrolling -> joined
-- 5. Resurrection prevention: removed state is terminal and cannot be overwritten
-- 6. Cross-account device-ban propagation and request cleanup
-- 7. Atomic admission finalization guard (finalize_participant_admission_tx)
-- 8. Comprehensive mutation detection (NULL-to-value, value-to-NULL, disappearance, appearance)
-- ============================================================================

-- Ensure supporting indexes exist
CREATE INDEX IF NOT EXISTS idx_meeting_join_requests_user_lookup
    ON public.meeting_join_requests (meeting_code, user_id);

CREATE INDEX IF NOT EXISTS idx_meeting_join_requests_fingerprint
    ON public.meeting_join_requests (meeting_code, device_fingerprint);

CREATE INDEX IF NOT EXISTS idx_meeting_device_bans_lookup
    ON public.meeting_device_bans (meeting_code, device_fingerprint);

CREATE INDEX IF NOT EXISTS idx_participants_meeting_fp
    ON public.participants (meeting_id, device_fingerprint);

-- ----------------------------------------------------------------------------
-- Safe expansion of participants_participant_status_check
-- Expands allowed statuses to: joined, disconnected, left, removed, enrolling
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    -- Check if participants_participant_status_check needs expansion
    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'participants_participant_status_check'
          AND conrelid = 'public.participants'::regclass
    ) THEN
        -- Only replace if 'enrolling' is not already in the definition
        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'participants_participant_status_check'
              AND conrelid = 'public.participants'::regclass
              AND pg_get_constraintdef(oid) LIKE '%enrolling%'
        ) THEN
            -- 1. Add replacement constraint as NOT VALID
            ALTER TABLE public.participants
                ADD CONSTRAINT participants_participant_status_check_new
                CHECK (participant_status::text = ANY (ARRAY['joined'::character varying, 'disconnected'::character varying, 'left'::character varying, 'removed'::character varying, 'enrolling'::character varying]::text[]))
                NOT VALID;

            -- 2. Validate the replacement constraint
            ALTER TABLE public.participants
                VALIDATE CONSTRAINT participants_participant_status_check_new;

            -- 3. Atomically drop old constraint and rename new constraint to original name
            ALTER TABLE public.participants
                DROP CONSTRAINT participants_participant_status_check;

            ALTER TABLE public.participants
                RENAME CONSTRAINT participants_participant_status_check_new
                TO participants_participant_status_check;
        END IF;
    ELSE
        -- If constraint does not exist, create it directly
        ALTER TABLE public.participants
            ADD CONSTRAINT participants_participant_status_check
            CHECK (participant_status::text = ANY (ARRAY['joined'::character varying, 'disconnected'::character varying, 'left'::character varying, 'removed'::character varying, 'enrolling'::character varying]::text[]));
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1. accept_join_request_tx: Reserve admission and move to 'enrolling'
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_join_request_tx(
    p_meeting_code TEXT,
    p_user_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_code VARCHAR(255);
    v_meeting_id UUID;
    v_meeting_status VARCHAR(50);
    v_is_deleted BOOLEAN;

    -- Unlocked read tracking variables
    v_req_found BOOLEAN := FALSE;
    v_request_id UUID := NULL;
    v_req_fp VARCHAR(255) := NULL;
    v_part_found BOOLEAN := FALSE;
    v_participant_id UUID := NULL;
    v_part_fp VARCHAR(255) := NULL;
    v_existing_status VARCHAR(50) := NULL;

    -- Locked re-read tracking variables
    v_locked_req_found BOOLEAN := FALSE;
    v_locked_req_id UUID := NULL;
    v_locked_fp VARCHAR(255) := NULL;
    v_locked_part_found BOOLEAN := FALSE;
    v_locked_part_id UUID := NULL;
    v_locked_part_fp VARCHAR(255) := NULL;
    v_locked_part_status VARCHAR(50) := NULL;

    v_ban_id UUID;
    v_hash_code INT;
    v_lock_rec RECORD;
BEGIN
    -- Input validation
    IF p_meeting_code IS NULL OR length(trim(p_meeting_code)) = 0 THEN
        RAISE EXCEPTION 'Meeting code is required';
    END IF;

    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'User ID is required';
    END IF;

    v_clean_code := upper(trim(p_meeting_code));

    -- Step 1: Verify meeting exists and lock with FOR SHARE (coordinates with meeting termination)
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

    -- Step 2: Per-user admission advisory lock (representing logical identity: meeting_code, user_id)
    PERFORM pg_advisory_xact_lock(
        hashtext('meetly-admission-user:' || v_clean_code),
        hashtext(p_user_id::text)
    );

    -- Step 3: Unlocked reads of pending request AND existing participant
    SELECT TRUE, id, nullif(trim(device_fingerprint), '')
    INTO v_req_found, v_request_id, v_req_fp
    FROM public.meeting_join_requests
    WHERE meeting_code = v_clean_code
      AND user_id = p_user_id
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT coalesce(v_req_found, false) THEN
        RAISE EXCEPTION 'Pending request not found';
    END IF;

    SELECT TRUE, participant_id, nullif(trim(device_fingerprint), ''), participant_status
    INTO v_part_found, v_participant_id, v_part_fp, v_existing_status
    FROM public.participants
    WHERE meeting_id = v_meeting_id
      AND user_id = p_user_id
    ORDER BY joined_at DESC
    LIMIT 1;

    -- Step 4: Acquire Transaction Advisory Lock(s) on all distinct non-empty fingerprints in deterministic hash order
    -- Serializes against concurrent ban_device_tx for any relevant physical device (request or participant)
    v_hash_code := hashtext(v_clean_code);

    FOR v_lock_rec IN
        SELECT DISTINCT hashtext(fp) AS h
        FROM unnest(ARRAY[v_req_fp, v_part_fp]) AS fp
        WHERE fp IS NOT NULL AND length(trim(fp)) > 0
        ORDER BY h ASC
    LOOP
        PERFORM pg_advisory_xact_lock(v_hash_code, v_lock_rec.h);
    END LOOP;

    -- Step 5 (Row-Lock Order 1): Re-read and lock request with FOR UPDATE on meeting_join_requests
    PERFORM id
    FROM public.meeting_join_requests
    WHERE meeting_code = v_clean_code
      AND user_id = p_user_id
    ORDER BY id
    FOR UPDATE;

    SELECT TRUE, id, nullif(trim(device_fingerprint), '')
    INTO v_locked_req_found, v_locked_req_id, v_locked_fp
    FROM public.meeting_join_requests
    WHERE meeting_code = v_clean_code
      AND user_id = p_user_id
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT coalesce(v_locked_req_found, false) THEN
        RAISE EXCEPTION 'Pending request not found';
    END IF;

    -- Abort if request fingerprint changed (handles NULL-to-value, value-to-NULL, value A-to-value B)
    IF v_locked_fp IS DISTINCT FROM v_req_fp THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    -- Step 6 (Row-Lock Order 2): Re-read and lock participant row with FOR UPDATE on participants
    PERFORM participant_id
    FROM public.participants
    WHERE meeting_id = v_meeting_id
      AND user_id = p_user_id
    ORDER BY participant_id
    FOR UPDATE;

    SELECT TRUE, participant_id, nullif(trim(device_fingerprint), ''), participant_status
    INTO v_locked_part_found, v_locked_part_id, v_locked_part_fp, v_locked_part_status
    FROM public.participants
    WHERE meeting_id = v_meeting_id
      AND user_id = p_user_id
    ORDER BY joined_at DESC
    LIMIT 1;

    -- Abort if participant changed concurrently
    IF coalesce(v_part_found, false) AND NOT coalesce(v_locked_part_found, false) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    IF NOT coalesce(v_part_found, false) AND coalesce(v_locked_part_found, false) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    IF coalesce(v_part_found, false) AND coalesce(v_locked_part_found, false) AND (v_locked_part_fp IS DISTINCT FROM v_part_fp) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    -- Step 7: ATOMIC DEVICE BAN VERIFICATION inside lock across all locked fingerprints
    SELECT id INTO v_ban_id
    FROM public.meeting_device_bans
    WHERE meeting_code = v_clean_code
      AND device_fingerprint IN (
        SELECT DISTINCT fp
        FROM unnest(ARRAY[v_locked_fp, v_locked_part_fp]) AS fp
        WHERE fp IS NOT NULL AND length(trim(fp)) > 0
      )
    LIMIT 1;

    IF v_ban_id IS NOT NULL THEN
        -- Note: Caller in Node.js explicitly rejects the request upon catching this exception,
        -- because an in-transaction DELETE would be rolled back by RAISE EXCEPTION.
        RAISE EXCEPTION 'Cannot admit participant: this device is banned from the meeting';
    END IF;

    -- Step 8: Reject terminal or already-admitted participant states using locked status
    IF coalesce(v_locked_part_found, false) THEN
        IF v_locked_part_status = 'removed' THEN
            RAISE EXCEPTION 'Cannot admit participant: user has been removed from this meeting';
        END IF;

        IF v_locked_part_status = 'joined' OR v_locked_part_status = 'enrolling' THEN
            RAISE EXCEPTION 'Cannot admit participant: user is already admitted to this meeting';
        END IF;
    END IF;

    -- Step 9: Atomic Consumption of Join Request
    DELETE FROM public.meeting_join_requests
    WHERE id = v_locked_req_id;

    -- Step 10: Transition participant record to 'enrolling' state
    IF coalesce(v_locked_part_found, false) THEN
        UPDATE public.participants
        SET participant_status = 'enrolling',
            device_fingerprint = v_locked_fp,
            joined_at = now(),
            left_at = NULL
        WHERE participant_id = v_locked_part_id;
    ELSE
        INSERT INTO public.participants (
            meeting_id,
            user_id,
            role,
            participant_status,
            device_fingerprint,
            joined_at
        ) VALUES (
            v_meeting_id,
            p_user_id,
            'participant',
            'enrolling',
            v_locked_fp,
            now()
        );
    END IF;

    RETURN v_locked_fp;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. finalize_participant_admission_tx: Finalize enrollment to 'joined'
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_participant_admission_tx(
    p_meeting_id UUID,
    p_user_id UUID,
    p_cloudflare_participant_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_code VARCHAR(255);
    v_meeting_status VARCHAR(50);
    v_is_deleted BOOLEAN;
    v_participant_found BOOLEAN := FALSE;
    v_fingerprint VARCHAR(255);
    v_status VARCHAR(50);
    v_locked_found BOOLEAN := FALSE;
    v_locked_fp VARCHAR(255);
    v_locked_status VARCHAR(50);
    v_ban_id UUID;
    v_updated_count INT;
BEGIN
    IF p_meeting_id IS NULL OR p_user_id IS NULL THEN
        RETURN FALSE;
    END IF;

    -- Step 1: Retrieve meeting details and lock FOR SHARE (coordinates with meeting termination)
    SELECT meeting_code, meeting_status, is_deleted
    INTO v_clean_code, v_meeting_status, v_is_deleted
    FROM public.meetings
    WHERE meeting_id = p_meeting_id
    FOR SHARE;

    IF v_clean_code IS NULL THEN
        RETURN FALSE;
    END IF;

    IF v_meeting_status = 'Ended' OR v_is_deleted = true THEN
        RETURN FALSE;
    END IF;

    v_clean_code := upper(trim(v_clean_code));

    -- Step 2: Per-user admission advisory lock (representing logical identity: meeting_code, user_id)
    PERFORM pg_advisory_xact_lock(
        hashtext('meetly-admission-user:' || v_clean_code),
        hashtext(p_user_id::text)
    );

    -- Step 3: Read participant state and fingerprint WITHOUT locking
    -- Explicitly distinguishes a missing participant from an existing participant with a NULL fingerprint
    SELECT TRUE, nullif(trim(device_fingerprint), ''), participant_status
    INTO v_participant_found, v_fingerprint, v_status
    FROM public.participants
    WHERE meeting_id = p_meeting_id
      AND user_id = p_user_id;

    IF NOT coalesce(v_participant_found, false) OR v_status IS DISTINCT FROM 'enrolling' THEN
        -- Participant does not exist or is not in 'enrolling' state
        RETURN FALSE;
    END IF;

    -- Step 4: Acquire Advisory Lock BEFORE taking row locks (prevents lock inversion/deadlocks with ban_device_tx)
    IF v_fingerprint IS NOT NULL AND length(trim(v_fingerprint)) > 0 THEN
        PERFORM pg_advisory_xact_lock(hashtext(v_clean_code), hashtext(v_fingerprint));
    END IF;

    -- Step 5: Re-read and lock participant record FOR UPDATE under advisory lock
    SELECT TRUE, nullif(trim(device_fingerprint), ''), participant_status
    INTO v_locked_found, v_locked_fp, v_locked_status
    FROM public.participants
    WHERE meeting_id = p_meeting_id
      AND user_id = p_user_id
    FOR UPDATE;

    IF NOT coalesce(v_locked_found, false) OR v_locked_status IS DISTINCT FROM 'enrolling' THEN
        RETURN FALSE;
    END IF;

    -- Verify fingerprint hasn't changed between initial read and lock acquisition (NULL-safe)
    IF v_locked_fp IS DISTINCT FROM v_fingerprint THEN
        RETURN FALSE;
    END IF;

    -- Step 6: Final verification that device was not banned during provider API call
    IF v_fingerprint IS NOT NULL AND length(trim(v_fingerprint)) > 0 THEN
        SELECT id INTO v_ban_id
        FROM public.meeting_device_bans
        WHERE meeting_code = v_clean_code
          AND device_fingerprint = v_fingerprint
        LIMIT 1;

        IF v_ban_id IS NOT NULL THEN
            -- Device was banned while provider was enrolling! Mark removed and abort
            UPDATE public.participants
            SET participant_status = 'removed',
                left_at = now()
            WHERE meeting_id = p_meeting_id
              AND user_id = p_user_id;
            RETURN FALSE;
        END IF;
    END IF;

    -- Step 7: Finalize participant to 'joined'
    UPDATE public.participants
    SET participant_status = 'joined',
        cloudflare_participant_id = p_cloudflare_participant_id,
        left_at = NULL
    WHERE meeting_id = p_meeting_id
      AND user_id = p_user_id
      AND participant_status = 'enrolling';

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    RETURN v_updated_count > 0;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. ban_device_tx: Complete Request-Row Locking Before Participant-Row Locking
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ban_device_tx(
    p_meeting_code TEXT,
    p_user_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_code VARCHAR(255);
    v_meeting_id UUID;
    v_meeting_status VARCHAR(50);
    v_is_deleted BOOLEAN;

    -- Unlocked read tracking variables
    v_req_found BOOLEAN := FALSE;
    v_req_fp VARCHAR(255) := NULL;
    v_part_found BOOLEAN := FALSE;
    v_part_fp VARCHAR(255) := NULL;

    -- Locked re-read tracking variables
    v_locked_req_found BOOLEAN := FALSE;
    v_locked_req_fp VARCHAR(255) := NULL;
    v_locked_part_found BOOLEAN := FALSE;
    v_locked_part_fp VARCHAR(255) := NULL;

    v_primary_fp VARCHAR(255);
    v_secondary_fp VARCHAR(255);
    v_hash_code INT;
    v_lock_rec RECORD;
BEGIN
    IF p_meeting_code IS NULL OR length(trim(p_meeting_code)) = 0 THEN
        RAISE EXCEPTION 'Meeting code is required';
    END IF;

    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'User ID is required';
    END IF;

    v_clean_code := upper(trim(p_meeting_code));

    -- Step 1: Verify meeting exists and lock FOR SHARE
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

    -- Step 2: Per-user admission advisory lock (representing logical identity: meeting_code, user_id)
    PERFORM pg_advisory_xact_lock(
        hashtext('meetly-admission-user:' || v_clean_code),
        hashtext(p_user_id::text)
    );

    -- Step 3: Unlocked Read of target user records from both tables
    -- Explicitly tracks row existence and fingerprint value (including NULL)
    SELECT TRUE, device_fingerprint
    INTO v_req_found, v_req_fp
    FROM public.meeting_join_requests
    WHERE meeting_code = v_clean_code
      AND user_id = p_user_id
    ORDER BY created_at DESC
    LIMIT 1;

    SELECT TRUE, device_fingerprint
    INTO v_part_found, v_part_fp
    FROM public.participants
    WHERE meeting_id = v_meeting_id
      AND user_id = p_user_id
    ORDER BY joined_at DESC
    LIMIT 1;

    -- Require at least one recorded non-empty fingerprint to ban
    IF (v_req_fp IS NULL OR length(trim(v_req_fp)) = 0) AND
       (v_part_fp IS NULL OR length(trim(v_part_fp)) = 0) THEN
        RAISE EXCEPTION 'Participant has no recorded device fingerprint';
    END IF;

    -- Prioritize current waiting request fingerprint as primary if present; otherwise participant fingerprint
    IF v_req_fp IS NOT NULL AND length(trim(v_req_fp)) > 0 THEN
        v_primary_fp := v_req_fp;
        IF v_part_fp IS NOT NULL AND length(trim(v_part_fp)) > 0 AND v_part_fp IS DISTINCT FROM v_req_fp THEN
            v_secondary_fp := v_part_fp;
        END IF;
    ELSE
        v_primary_fp := v_part_fp;
    END IF;

    -- Step 3: Acquire Transaction Advisory Lock(s)
    -- When locking fingerprints, acquire in deterministic hash order to prevent deadlock
    v_hash_code := hashtext(v_clean_code);
    FOR v_lock_rec IN
        SELECT DISTINCT hashtext(fp) AS h
        FROM unnest(ARRAY[v_primary_fp, v_secondary_fp]) AS fp
        WHERE fp IS NOT NULL AND length(trim(fp)) > 0
        ORDER BY h ASC
    LOOP
        PERFORM pg_advisory_xact_lock(v_hash_code, v_lock_rec.h);
    END LOOP;

    -- Step 4: STRICT GLOBAL ROW-LOCK ORDERING
    -- =========================================================================
    -- ROW LOCK ORDER 1: Lock ALL affected meeting_join_requests rows FIRST (ORDER BY id)
    -- This includes target user's request AND any cross-account requests matching primary or secondary fingerprint.
    -- Locking every request row that will be deleted BEFORE touching participants eliminates lock inversion!
    PERFORM id
    FROM public.meeting_join_requests
    WHERE meeting_code = v_clean_code
      AND (
        user_id = p_user_id
        OR device_fingerprint = v_primary_fp
        OR (v_secondary_fp IS NOT NULL AND device_fingerprint = v_secondary_fp)
      )
    ORDER BY id
    FOR UPDATE;

    -- Re-read target user's waiting request under the row lock
    SELECT TRUE, device_fingerprint
    INTO v_locked_req_found, v_locked_req_fp
    FROM public.meeting_join_requests
    WHERE meeting_code = v_clean_code
      AND user_id = p_user_id
    ORDER BY created_at DESC
    LIMIT 1;

    -- Step 4.1: Comprehensive Mutation Validation on meeting_join_requests
    -- Detects: row disappearing, row appearing, NULL -> value, value -> NULL, value A -> value B
    IF coalesce(v_req_found, false) AND NOT coalesce(v_locked_req_found, false) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    IF NOT coalesce(v_req_found, false) AND coalesce(v_locked_req_found, false) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    IF coalesce(v_req_found, false) AND coalesce(v_locked_req_found, false) AND (v_locked_req_fp IS DISTINCT FROM v_req_fp) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    -- ROW LOCK ORDER 2: Lock ALL affected participants rows SECOND (ORDER BY participant_id)
    -- This includes target user's participant row AND any cross-account participants matching either fingerprint.
    PERFORM participant_id
    FROM public.participants
    WHERE meeting_id = v_meeting_id
      AND (
        user_id = p_user_id
        OR device_fingerprint = v_primary_fp
        OR (v_secondary_fp IS NOT NULL AND device_fingerprint = v_secondary_fp)
      )
    ORDER BY participant_id
    FOR UPDATE;

    -- Re-read target user's participant row under the row lock
    SELECT TRUE, device_fingerprint
    INTO v_locked_part_found, v_locked_part_fp
    FROM public.participants
    WHERE meeting_id = v_meeting_id
      AND user_id = p_user_id
    ORDER BY joined_at DESC
    LIMIT 1;

    -- Step 4.2: Comprehensive Mutation Validation on participants
    -- Detects: row disappearing, row appearing, NULL -> value, value -> NULL, value A -> value B
    IF coalesce(v_part_found, false) AND NOT coalesce(v_locked_part_found, false) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    IF NOT coalesce(v_part_found, false) AND coalesce(v_locked_part_found, false) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    IF coalesce(v_part_found, false) AND coalesce(v_locked_part_found, false) AND (v_locked_part_fp IS DISTINCT FROM v_part_fp) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    -- Step 5: Insert ban record(s) idempotently
    INSERT INTO public.meeting_device_bans (meeting_code, device_fingerprint, blocked_at)
    VALUES (v_clean_code, v_primary_fp, now())
    ON CONFLICT (meeting_code, device_fingerprint) DO NOTHING;

    IF v_secondary_fp IS NOT NULL THEN
        INSERT INTO public.meeting_device_bans (meeting_code, device_fingerprint, blocked_at)
        VALUES (v_clean_code, v_secondary_fp, now())
        ON CONFLICT (meeting_code, device_fingerprint) DO NOTHING;
    END IF;

    -- Step 6: Atomic Cross-Account Deletions & Updates (requests -> participants)
    -- Since all affected request rows were already locked in Step 4, DELETE acquires no new locks.
    -- Deletes target user's request AND any cross-account requests matching primary or secondary fingerprint.
    IF v_secondary_fp IS NOT NULL THEN
        DELETE FROM public.meeting_join_requests
        WHERE meeting_code = v_clean_code
          AND (
            user_id = p_user_id
            OR device_fingerprint IN (v_primary_fp, v_secondary_fp)
          );
    ELSE
        DELETE FROM public.meeting_join_requests
        WHERE meeting_code = v_clean_code
          AND (
            user_id = p_user_id
            OR device_fingerprint = v_primary_fp
          );
    END IF;

    -- Since all affected participant rows were already locked in Step 4, UPDATE acquires no new locks.
    -- Updates target user's participant record AND any cross-account participants matching primary or secondary fingerprint.
    IF v_secondary_fp IS NOT NULL THEN
        UPDATE public.participants
        SET participant_status = 'removed',
            left_at = now()
        WHERE meeting_id = v_meeting_id
          AND (
            user_id = p_user_id
            OR device_fingerprint IN (v_primary_fp, v_secondary_fp)
          );
    ELSE
        UPDATE public.participants
        SET participant_status = 'removed',
            left_at = now()
        WHERE meeting_id = v_meeting_id
          AND (
            user_id = p_user_id
            OR device_fingerprint = v_primary_fp
          );
    END IF;

    RETURN v_primary_fp;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. create_join_request_tx: Atomic Join-Request Creation Under Advisory Lock
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_join_request_tx(
    p_meeting_code TEXT,
    p_user_id UUID,
    p_device_fingerprint TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_code VARCHAR(255);
    v_incoming_fp VARCHAR(255);
    v_meeting_id UUID;
    v_meeting_status VARCHAR(50);
    v_is_deleted BOOLEAN;
    v_ban_id UUID;

    -- Unlocked read tracking variables
    v_req_found BOOLEAN := FALSE;
    v_existing_req_id UUID := NULL;
    v_existing_req_fp VARCHAR(255) := NULL;
    v_part_found BOOLEAN := FALSE;
    v_existing_part_id UUID := NULL;
    v_existing_part_fp VARCHAR(255) := NULL;
    v_existing_part_status VARCHAR(50) := NULL;

    -- Locked re-read tracking variables
    v_locked_req_found BOOLEAN := FALSE;
    v_locked_req_id UUID := NULL;
    v_locked_req_fp VARCHAR(255) := NULL;
    v_locked_part_found BOOLEAN := FALSE;
    v_locked_part_id UUID := NULL;
    v_locked_part_fp VARCHAR(255) := NULL;
    v_locked_part_status VARCHAR(50) := NULL;

    v_new_req_id UUID;
    v_hash_code INT;
    v_lock_rec RECORD;
BEGIN
    IF p_meeting_code IS NULL OR length(trim(p_meeting_code)) = 0 THEN
        RAISE EXCEPTION 'Meeting code is required';
    END IF;

    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'User ID is required';
    END IF;

    v_clean_code := upper(trim(p_meeting_code));
    v_incoming_fp := nullif(trim(p_device_fingerprint), '');

    -- Step 1: Verify meeting exists and lock FOR SHARE
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

    -- Step 2: Per-user admission advisory lock (representing logical identity: meeting_code, user_id)
    PERFORM pg_advisory_xact_lock(
        hashtext('meetly-admission-user:' || v_clean_code),
        hashtext(p_user_id::text)
    );

    -- Step 3: Unlocked reads of existing waiting-request and participant fingerprints
    SELECT TRUE, id, nullif(trim(device_fingerprint), '')
    INTO v_req_found, v_existing_req_id, v_existing_req_fp
    FROM public.meeting_join_requests
    WHERE meeting_code = v_clean_code
      AND user_id = p_user_id
    ORDER BY created_at DESC
    LIMIT 1;

    SELECT TRUE, participant_id, nullif(trim(device_fingerprint), ''), participant_status
    INTO v_part_found, v_existing_part_id, v_existing_part_fp, v_existing_part_status
    FROM public.participants
    WHERE meeting_id = v_meeting_id
      AND user_id = p_user_id
    ORDER BY joined_at DESC
    LIMIT 1;

    -- Step 4: Acquire Transaction Advisory Lock(s) in deterministic hash order
    -- Locks all distinct non-empty fingerprints from request, participant, and incoming
    v_hash_code := hashtext(v_clean_code);

    FOR v_lock_rec IN
        SELECT DISTINCT hashtext(fp) AS h
        FROM unnest(ARRAY[v_existing_req_fp, v_existing_part_fp, v_incoming_fp]) AS fp
        WHERE fp IS NOT NULL AND length(trim(fp)) > 0
        ORDER BY h ASC
    LOOP
        PERFORM pg_advisory_xact_lock(v_hash_code, v_lock_rec.h);
    END LOOP;

    -- Step 5 (Row-Lock Order 1): Re-read and lock request row(s) FOR UPDATE
    PERFORM id
    FROM public.meeting_join_requests
    WHERE meeting_code = v_clean_code
      AND user_id = p_user_id
    ORDER BY id
    FOR UPDATE;

    SELECT TRUE, id, nullif(trim(device_fingerprint), '')
    INTO v_locked_req_found, v_locked_req_id, v_locked_req_fp
    FROM public.meeting_join_requests
    WHERE meeting_code = v_clean_code
      AND user_id = p_user_id
    ORDER BY created_at DESC
    LIMIT 1;

    -- Comprehensive Mutation Validation on meeting_join_requests
    IF coalesce(v_req_found, false) AND NOT coalesce(v_locked_req_found, false) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    IF NOT coalesce(v_req_found, false) AND coalesce(v_locked_req_found, false) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    IF coalesce(v_req_found, false) AND coalesce(v_locked_req_found, false) AND (v_locked_req_fp IS DISTINCT FROM v_existing_req_fp) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    -- Step 6 (Row-Lock Order 2): Re-read and lock participant row FOR UPDATE
    PERFORM participant_id
    FROM public.participants
    WHERE meeting_id = v_meeting_id
      AND user_id = p_user_id
    ORDER BY participant_id
    FOR UPDATE;

    SELECT TRUE, participant_id, nullif(trim(device_fingerprint), ''), participant_status
    INTO v_locked_part_found, v_locked_part_id, v_locked_part_fp, v_locked_part_status
    FROM public.participants
    WHERE meeting_id = v_meeting_id
      AND user_id = p_user_id
    ORDER BY joined_at DESC
    LIMIT 1;

    -- Comprehensive Mutation Validation on participants
    IF coalesce(v_part_found, false) AND NOT coalesce(v_locked_part_found, false) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    IF NOT coalesce(v_part_found, false) AND coalesce(v_locked_part_found, false) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    IF coalesce(v_part_found, false) AND coalesce(v_locked_part_found, false) AND (v_locked_part_fp IS DISTINCT FROM v_existing_part_fp) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    -- Step 7: Check device bans against all relevant locked/incoming fingerprints
    SELECT id INTO v_ban_id
    FROM public.meeting_device_bans
    WHERE meeting_code = v_clean_code
      AND device_fingerprint IN (
        SELECT DISTINCT fp
        FROM unnest(ARRAY[v_locked_req_fp, v_locked_part_fp, v_incoming_fp]) AS fp
        WHERE fp IS NOT NULL AND length(trim(fp)) > 0
      )
    LIMIT 1;

    IF v_ban_id IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot join: this device is banned from the meeting';
    END IF;

    -- Step 8: Reject removed, joined, and enrolling participants using locked status
    IF coalesce(v_locked_part_found, false) THEN
        IF v_locked_part_status = 'removed' THEN
            RAISE EXCEPTION 'Cannot join: user has been removed from this meeting';
        END IF;

        IF v_locked_part_status = 'joined' OR v_locked_part_status = 'enrolling' THEN
            RAISE EXCEPTION 'Cannot join: user is already admitted to this meeting';
        END IF;
    END IF;

    -- Step 9: Update or Insert
    IF coalesce(v_locked_req_found, false) THEN
        -- Explicitly update device_fingerprint to v_incoming_fp (handles NULL-to-value, value-to-NULL, value A-to-value B)
        UPDATE public.meeting_join_requests
        SET device_fingerprint = v_incoming_fp,
            status = 'pending',
            created_at = now()
        WHERE id = v_locked_req_id;

        RETURN jsonb_build_object(
            'request_id', v_locked_req_id,
            'status', 'pending',
            'is_duplicate', true
        );
    ELSE
        INSERT INTO public.meeting_join_requests (
            id,
            meeting_code,
            user_id,
            device_fingerprint,
            status,
            created_at
        )
        VALUES (
            gen_random_uuid(),
            v_clean_code,
            p_user_id,
            v_incoming_fp,
            'pending',
            now()
        )
        RETURNING id INTO v_new_req_id;

        RETURN jsonb_build_object(
            'request_id', v_new_req_id,
            'status', 'pending',
            'is_duplicate', false
        );
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. auto_admit_participant_tx: Atomic Participant Admission Under Advisory Lock
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_admit_participant_tx(
    p_meeting_code TEXT,
    p_user_id UUID,
    p_device_fingerprint TEXT,
    p_role TEXT DEFAULT 'participant'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_code VARCHAR(255);
    v_incoming_fp VARCHAR(255);
    v_meeting_id UUID;
    v_meeting_status VARCHAR(50);
    v_is_deleted BOOLEAN;
    v_ban_id UUID;

    -- Unlocked read tracking variables
    v_req_found BOOLEAN := FALSE;
    v_req_fp VARCHAR(255) := NULL;
    v_part_found BOOLEAN := FALSE;
    v_part_fp VARCHAR(255) := NULL;
    v_part_status VARCHAR(50) := NULL;
    v_existing_role VARCHAR(50) := NULL;

    -- Locked re-read tracking variables
    v_locked_req_found BOOLEAN := FALSE;
    v_locked_req_fp VARCHAR(255) := NULL;
    v_locked_part_found BOOLEAN := FALSE;
    v_locked_part_id UUID := NULL;
    v_locked_part_fp VARCHAR(255) := NULL;
    v_locked_part_status VARCHAR(50) := NULL;
    v_locked_role VARCHAR(50) := NULL;

    v_final_role VARCHAR(50);
    v_hash_code INT;
    v_lock_rec RECORD;
BEGIN
    -- Input validation
    IF p_meeting_code IS NULL OR length(trim(p_meeting_code)) = 0 THEN
        RAISE EXCEPTION 'Meeting code is required';
    END IF;

    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'User ID is required';
    END IF;

    v_clean_code := upper(trim(p_meeting_code));
    v_incoming_fp := nullif(trim(p_device_fingerprint), '');

    -- Step 1: Verify meeting exists and lock FOR SHARE
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

    -- Step 2: Per-user admission advisory lock (representing logical identity: meeting_code, user_id)
    PERFORM pg_advisory_xact_lock(
        hashtext('meetly-admission-user:' || v_clean_code),
        hashtext(p_user_id::text)
    );

    -- Step 3: Unlocked reads of existing waiting-request and participant fingerprints
    SELECT TRUE, nullif(trim(device_fingerprint), '')
    INTO v_req_found, v_req_fp
    FROM public.meeting_join_requests
    WHERE meeting_code = v_clean_code
      AND user_id = p_user_id
    ORDER BY created_at DESC
    LIMIT 1;

    SELECT TRUE, nullif(trim(device_fingerprint), ''), participant_status, role
    INTO v_part_found, v_part_fp, v_part_status, v_existing_role
    FROM public.participants
    WHERE meeting_id = v_meeting_id
      AND user_id = p_user_id
    ORDER BY joined_at DESC
    LIMIT 1;

    -- Step 4: Build distinct non-empty fingerprints and acquire advisory locks in deterministic hash order
    v_hash_code := hashtext(v_clean_code);

    FOR v_lock_rec IN
        SELECT DISTINCT hashtext(fp) AS h
        FROM unnest(ARRAY[v_req_fp, v_part_fp, v_incoming_fp]) AS fp
        WHERE fp IS NOT NULL AND length(trim(fp)) > 0
        ORDER BY h ASC
    LOOP
        PERFORM pg_advisory_xact_lock(v_hash_code, v_lock_rec.h);
    END LOOP;

    -- Step 5 (Row-Lock Order 1): Re-read and lock affected waiting-request rows in deterministic id order
    PERFORM id
    FROM public.meeting_join_requests
    WHERE meeting_code = v_clean_code
      AND user_id = p_user_id
    ORDER BY id
    FOR UPDATE;

    SELECT TRUE, nullif(trim(device_fingerprint), '')
    INTO v_locked_req_found, v_locked_req_fp
    FROM public.meeting_join_requests
    WHERE meeting_code = v_clean_code
      AND user_id = p_user_id
    ORDER BY created_at DESC
    LIMIT 1;

    -- Step 5: Verify waiting-request existence and fingerprint match initial read
    IF coalesce(v_req_found, false) AND NOT coalesce(v_locked_req_found, false) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    IF NOT coalesce(v_req_found, false) AND coalesce(v_locked_req_found, false) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    IF coalesce(v_req_found, false) AND coalesce(v_locked_req_found, false) AND (v_locked_req_fp IS DISTINCT FROM v_req_fp) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    -- Step 6 (Row-Lock Order 2): Re-read and lock participant row in deterministic participant_id order
    PERFORM participant_id
    FROM public.participants
    WHERE meeting_id = v_meeting_id
      AND user_id = p_user_id
    ORDER BY participant_id
    FOR UPDATE;

    SELECT TRUE, participant_id, nullif(trim(device_fingerprint), ''), participant_status, role
    INTO v_locked_part_found, v_locked_part_id, v_locked_part_fp, v_locked_part_status, v_locked_role
    FROM public.participants
    WHERE meeting_id = v_meeting_id
      AND user_id = p_user_id
    ORDER BY joined_at DESC
    LIMIT 1;

    -- Step 7: Verify participant existence and fingerprint match initial read
    IF coalesce(v_part_found, false) AND NOT coalesce(v_locked_part_found, false) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    IF NOT coalesce(v_part_found, false) AND coalesce(v_locked_part_found, false) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    IF coalesce(v_part_found, false) AND coalesce(v_locked_part_found, false) AND (v_locked_part_fp IS DISTINCT FROM v_part_fp) THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    -- Step 8: Check device bans for all relevant fingerprints while holding locks
    SELECT id INTO v_ban_id
    FROM public.meeting_device_bans
    WHERE meeting_code = v_clean_code
      AND device_fingerprint IN (
        SELECT DISTINCT fp
        FROM unnest(ARRAY[v_locked_req_fp, v_locked_part_fp, v_incoming_fp]) AS fp
        WHERE fp IS NOT NULL AND length(trim(fp)) > 0
      )
    LIMIT 1;

    IF v_ban_id IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot admit participant: this device is banned from the meeting';
    END IF;

    -- Step 9: Preserve terminal removed status protection
    IF v_locked_part_status = 'removed' THEN
        RAISE EXCEPTION 'Cannot admit participant: user has been removed from this meeting';
    END IF;

    -- Step 10 & 11: Role handling, participant upsert, and request cleanup
    v_final_role := coalesce(v_locked_role, p_role, 'participant');

    IF coalesce(v_locked_part_found, false) THEN
        UPDATE public.participants
        SET participant_status = 'joined',
            role = v_final_role,
            device_fingerprint = coalesce(v_incoming_fp, device_fingerprint),
            joined_at = now(),
            left_at = NULL
        WHERE participant_id = v_locked_part_id;
    ELSE
        v_locked_part_id := gen_random_uuid();
        INSERT INTO public.participants (
            participant_id,
            meeting_id,
            user_id,
            role,
            participant_status,
            device_fingerprint,
            joined_at,
            left_at
        )
        VALUES (
            v_locked_part_id,
            v_meeting_id,
            p_user_id,
            v_final_role,
            'joined',
            v_incoming_fp,
            now(),
            NULL
        );
    END IF;

    -- Clean up all lingering waiting requests for this user in this meeting
    -- (request rows were already locked in Step 4, so DELETE acquires no new locks after participant locks)
    DELETE FROM public.meeting_join_requests
    WHERE meeting_code = v_clean_code
      AND user_id = p_user_id;

    RETURN jsonb_build_object(
        'participant_id', v_locked_part_id,
        'status', 'joined',
        'role', v_final_role
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. reject_join_request_tx: Atomic Join-Request Rejection Under Advisory Lock
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_join_request_tx(
    p_meeting_code TEXT,
    p_user_id UUID
)
RETURNS BOOLEAN
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
    v_req_id UUID;
    v_locked_req_id UUID;
    v_locked_fp VARCHAR(255);
BEGIN
    IF p_meeting_code IS NULL OR length(trim(p_meeting_code)) = 0 THEN
        RAISE EXCEPTION 'Meeting code is required';
    END IF;

    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'User ID is required';
    END IF;

    v_clean_code := upper(trim(p_meeting_code));

    -- Step 1: Verify meeting exists and lock FOR SHARE
    SELECT meeting_id, meeting_status, is_deleted
    INTO v_meeting_id, v_meeting_status, v_is_deleted
    FROM public.meetings
    WHERE meeting_code = v_clean_code
    FOR SHARE;

    IF v_meeting_id IS NULL THEN
        -- Request already handled or missing / meeting missing (safe no-op)
        RETURN FALSE;
    END IF;

    -- Step 2: Per-user admission advisory lock (representing logical identity: meeting_code, user_id)
    PERFORM pg_advisory_xact_lock(
        hashtext('meetly-admission-user:' || v_clean_code),
        hashtext(p_user_id::text)
    );

    -- Step 3: Unlocked read of request to determine advisory lock key
    SELECT id, nullif(trim(device_fingerprint), '')
    INTO v_req_id, v_fingerprint
    FROM public.meeting_join_requests
    WHERE meeting_code = v_clean_code
      AND user_id = p_user_id
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_req_id IS NULL THEN
        -- Request already handled or missing (safe no-op)
        RETURN FALSE;
    END IF;

    -- Step 4: Acquire Fingerprint Advisory Lock on (meeting_code, device_fingerprint)
    IF v_fingerprint IS NOT NULL AND length(v_fingerprint) > 0 THEN
        PERFORM pg_advisory_xact_lock(hashtext(v_clean_code), hashtext(v_fingerprint));
    END IF;

    -- Step 5 (Row-Lock Order 1): Re-read and lock affected requests FOR UPDATE
    PERFORM id
    FROM public.meeting_join_requests
    WHERE meeting_code = v_clean_code
      AND user_id = p_user_id
    ORDER BY id
    FOR UPDATE;

    SELECT id, nullif(trim(device_fingerprint), '')
    INTO v_locked_req_id, v_locked_fp
    FROM public.meeting_join_requests
    WHERE meeting_code = v_clean_code
      AND user_id = p_user_id
    ORDER BY created_at DESC
    LIMIT 1;

    -- Detect disappearance between unlocked read and locked read (safe no-op)
    IF v_locked_req_id IS NULL THEN
        RETURN FALSE;
    END IF;

    -- Detect fingerprint mutation using IS DISTINCT FROM (controlled conflict)
    IF v_locked_fp IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'Device fingerprint changed concurrently; please retry';
    END IF;

    -- Step 6: Atomic deletion (not using stale fingerprint lock)
    DELETE FROM public.meeting_join_requests
    WHERE id = v_locked_req_id;

    RETURN TRUE;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Restrict Function Privileges
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.accept_join_request_tx(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_join_request_tx(TEXT, UUID) TO service_role, postgres;

REVOKE EXECUTE ON FUNCTION public.finalize_participant_admission_tx(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_participant_admission_tx(UUID, UUID, TEXT) TO service_role, postgres;

REVOKE EXECUTE ON FUNCTION public.ban_device_tx(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ban_device_tx(TEXT, UUID) TO service_role, postgres;

REVOKE EXECUTE ON FUNCTION public.create_join_request_tx(TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_join_request_tx(TEXT, UUID, TEXT) TO service_role, postgres;

REVOKE EXECUTE ON FUNCTION public.auto_admit_participant_tx(TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_admit_participant_tx(TEXT, UUID, TEXT, TEXT) TO service_role, postgres;

REVOKE EXECUTE ON FUNCTION public.reject_join_request_tx(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_join_request_tx(TEXT, UUID) TO service_role, postgres;
