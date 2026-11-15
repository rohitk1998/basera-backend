-- Public bucket for guest story photos.
-- Uploads happen only through POST /api/stories/media (service-role client, after AuthGuard),
-- so there is no browser INSERT policy. Path: {userId}/{uuid}.{jpg|png|webp}.
-- Idempotent: safe to re-run; re-running also resets the limits.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'story-media',
  'story-media',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET public = true,
    file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];
