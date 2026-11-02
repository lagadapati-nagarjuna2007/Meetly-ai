-- ============================================================================
-- Migration: 20261031_cloudflare_realtime_schema.sql
-- Description: Backward-Compatible Schema for Cloudflare RealtimeKit Integration
--
-- Objective:
-- 1. Adds cloudflare_meeting_id (TEXT, nullable) to public.meetings
-- 2. Adds cloudflare_participant_id (TEXT, nullable) to public.participants
-- 3. Adds indexes for fast lookups by Cloudflare identifiers
-- 4. Preserves room_name and all existing LiveKit columns and constraints
-- 5. Non-destructive: Uses IF NOT EXISTS to guarantee idempotent, safe application
-- ============================================================================

DO $$ 
BEGIN
    -- 1. Add cloudflare_meeting_id to public.meetings
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'meetings' 
          AND column_name = 'cloudflare_meeting_id'
    ) THEN
        ALTER TABLE public.meetings 
            ADD COLUMN cloudflare_meeting_id TEXT;

        COMMENT ON COLUMN public.meetings.cloudflare_meeting_id IS 
            'Cloudflare RealtimeKit meeting identifier generated via REST API.';
    END IF;

    -- 2. Add cloudflare_participant_id to public.participants
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'participants' 
          AND column_name = 'cloudflare_participant_id'
    ) THEN
        ALTER TABLE public.participants 
            ADD COLUMN cloudflare_participant_id TEXT;

        COMMENT ON COLUMN public.participants.cloudflare_participant_id IS 
            'Cloudflare RealtimeKit participant session identifier generated via REST API.';
    END IF;
END $$;

-- 3. Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_meetings_cloudflare_meeting_id 
    ON public.meetings (cloudflare_meeting_id) 
    WHERE cloudflare_meeting_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_participants_cloudflare_participant_id 
    ON public.participants (cloudflare_participant_id) 
    WHERE cloudflare_participant_id IS NOT NULL;
