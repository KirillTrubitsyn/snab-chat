-- Add video_seen flag to invite_codes
-- Tracks whether the user has watched the onboarding video presentation.
-- Set to TRUE after first viewing; checked on every login to avoid replaying.
ALTER TABLE invite_codes ADD COLUMN IF NOT EXISTS video_seen BOOLEAN DEFAULT FALSE;
