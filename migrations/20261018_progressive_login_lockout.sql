-- ==============================================================================
-- Meetly AI — Progressive Login Lockout Migration
-- Date: 2026-10-18
--
-- Objective:
-- 1. Create public.auth_lockouts table to persist consecutive login failure
--    streaks and progressive lockout tiers across backend restarts and instances.
-- 2. Restrict direct table access via RLS: inaccessible to anon and authenticated,
--    granted exclusively to service_role.
-- 3. Provide transaction-safe, atomic SECURITY DEFINER functions for:
--    - check_login_lockout
--    - record_login_failure (with row-level lock to prevent concurrent bypass)
--    - reset_login_lockout
-- ==============================================================================

-- 1. Create table for lockout state persistence
CREATE TABLE IF NOT EXISTS public.auth_lockouts (
  email TEXT PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  lockout_tier INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index on locked_until for quick lookup and expiration checks
CREATE INDEX IF NOT EXISTS idx_auth_lockouts_locked_until ON public.auth_lockouts (locked_until);

-- 2. Enable Row Level Security (RLS)
ALTER TABLE public.auth_lockouts ENABLE ROW LEVEL SECURITY;

-- Revoke all table-level privileges from untrusted client roles
REVOKE ALL ON TABLE public.auth_lockouts FROM PUBLIC;
REVOKE ALL ON TABLE public.auth_lockouts FROM anon;
REVOKE ALL ON TABLE public.auth_lockouts FROM authenticated;

-- Grant full table privileges exclusively to backend service_role
GRANT ALL ON TABLE public.auth_lockouts TO service_role;

-- 3. Atomic Function: check_login_lockout
CREATE OR REPLACE FUNCTION public.check_login_lockout(p_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_norm_email TEXT;
  v_record RECORD;
  v_now TIMESTAMPTZ := NOW();
  v_remaining_secs INT;
BEGIN
  v_norm_email := LOWER(TRIM(p_email));
  IF v_norm_email IS NULL OR v_norm_email = '' THEN
    RETURN jsonb_build_object(
      'is_locked', FALSE,
      'remaining_seconds', 0,
      'locked_until', NULL,
      'lockout_tier', 0,
      'failed_attempts', 0
    );
  END IF;

  SELECT email, failed_attempts, lockout_tier, locked_until
  INTO v_record
  FROM public.auth_lockouts
  WHERE email = v_norm_email;

  IF NOT FOUND OR v_record.locked_until IS NULL OR v_record.locked_until <= v_now THEN
    RETURN jsonb_build_object(
      'is_locked', FALSE,
      'remaining_seconds', 0,
      'locked_until', NULL,
      'lockout_tier', COALESCE(v_record.lockout_tier, 0),
      'failed_attempts', COALESCE(v_record.failed_attempts, 0)
    );
  END IF;

  v_remaining_secs := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_record.locked_until - v_now)))::INT);
  RETURN jsonb_build_object(
    'is_locked', TRUE,
    'remaining_seconds', v_remaining_secs,
    'locked_until', v_record.locked_until,
    'lockout_tier', v_record.lockout_tier,
    'failed_attempts', v_record.failed_attempts
  );
END;
$$;

-- 4. Atomic Function: record_login_failure
-- Uses SELECT ... FOR UPDATE to prevent race condition counter bypass
CREATE OR REPLACE FUNCTION public.record_login_failure(
  p_email TEXT,
  p_max_attempts INT DEFAULT 4,
  p_base_duration_secs INT DEFAULT 120,
  p_multiplier INT DEFAULT 5,
  p_max_duration_secs INT DEFAULT 86400
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_norm_email TEXT;
  v_now TIMESTAMPTZ := NOW();
  v_record RECORD;
  v_failed_attempts INT;
  v_lockout_tier INT;
  v_locked_until TIMESTAMPTZ;
  v_duration_secs NUMERIC;
  v_is_locked BOOLEAN := FALSE;
  v_remaining_secs INT := 0;
BEGIN
  v_norm_email := LOWER(TRIM(p_email));
  IF v_norm_email IS NULL OR v_norm_email = '' THEN
    RETURN jsonb_build_object('is_locked', FALSE, 'remaining_seconds', 0);
  END IF;

  -- Ensure record exists so we can acquire a row-level lock
  INSERT INTO public.auth_lockouts (email, failed_attempts, lockout_tier, created_at, updated_at)
  VALUES (v_norm_email, 0, 0, v_now, v_now)
  ON CONFLICT (email) DO NOTHING;

  -- Acquire row lock
  SELECT * INTO v_record
  FROM public.auth_lockouts
  WHERE email = v_norm_email
  FOR UPDATE;

  -- A. If account is currently locked, do not extend lockout or increment counter
  IF v_record.locked_until IS NOT NULL AND v_record.locked_until > v_now THEN
    v_remaining_secs := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_record.locked_until - v_now)))::INT);
    RETURN jsonb_build_object(
      'is_locked', TRUE,
      'remaining_seconds', v_remaining_secs,
      'locked_until', v_record.locked_until,
      'lockout_tier', v_record.lockout_tier,
      'failed_attempts', v_record.failed_attempts
    );
  END IF;

  -- B. Lockout has expired (or was never active): increment failures for current cycle
  v_failed_attempts := v_record.failed_attempts + 1;
  v_lockout_tier := v_record.lockout_tier;

  -- Check if group threshold (default: 4) is reached
  IF v_failed_attempts >= p_max_attempts THEN
    v_lockout_tier := v_lockout_tier + 1;
    -- Progressive multiplier calculation: base * (multiplier ^ (tier - 1))
    v_duration_secs := p_base_duration_secs * (p_multiplier ^ (v_lockout_tier - 1));
    IF v_duration_secs > p_max_duration_secs OR v_duration_secs < 0 THEN
      v_duration_secs := p_max_duration_secs;
    END IF;

    v_locked_until := v_now + (v_duration_secs || ' seconds')::INTERVAL;
    v_failed_attempts := 0; -- Reset counter for subsequent tier
    v_is_locked := TRUE;
    v_remaining_secs := v_duration_secs::INT;
  ELSE
    v_locked_until := NULL;
    v_is_locked := FALSE;
    v_remaining_secs := 0;
  END IF;

  UPDATE public.auth_lockouts
  SET failed_attempts = v_failed_attempts,
      lockout_tier = v_lockout_tier,
      locked_until = v_locked_until,
      last_failed_at = v_now,
      updated_at = v_now
  WHERE email = v_norm_email;

  RETURN jsonb_build_object(
    'is_locked', v_is_locked,
    'remaining_seconds', v_remaining_secs,
    'locked_until', v_locked_until,
    'lockout_tier', v_lockout_tier,
    'failed_attempts', v_failed_attempts
  );
END;
$$;

-- 5. Atomic Function: reset_login_lockout
CREATE OR REPLACE FUNCTION public.reset_login_lockout(p_email TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_norm_email TEXT;
BEGIN
  v_norm_email := LOWER(TRIM(p_email));
  IF v_norm_email IS NULL OR v_norm_email = '' THEN
    RETURN;
  END IF;

  UPDATE public.auth_lockouts
  SET failed_attempts = 0,
      lockout_tier = 0,
      locked_until = NULL,
      updated_at = NOW()
  WHERE email = v_norm_email;
END;
$$;

-- 6. Function Execution Permissions
REVOKE ALL ON FUNCTION public.check_login_lockout(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_login_failure(TEXT, INT, INT, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reset_login_lockout(TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.check_login_lockout(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_login_failure(TEXT, INT, INT, INT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.reset_login_lockout(TEXT) TO service_role;
