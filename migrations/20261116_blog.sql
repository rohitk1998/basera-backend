-- Blog: posts written in the admin console, read publicly at /blog.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS blog_posts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE,
  title            text NOT NULL,
  excerpt          text NOT NULL DEFAULT '',
  body_md          text NOT NULL DEFAULT '',
  cover_image_url  text,
  cover_alt        text,
  category         text,
  tags             text[] NOT NULL DEFAULT '{}',
  locale           text NOT NULL DEFAULT 'en',
  seo_title        text,
  seo_description  text,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at     timestamptz,
  author_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS blog_posts_pub_idx
  ON blog_posts (status, published_at DESC);
CREATE INDEX IF NOT EXISTS blog_posts_category_idx
  ON blog_posts (category) WHERE status = 'published';

-- RLS on, no policies: the backend reaches the table with the service role / owner connection,
-- the browser never reads it directly.
ALTER TABLE blog_posts ENABLE ROW LEVEL SECURITY;

-- Public bucket for blog cover and inline images.
-- Uploads happen only through POST /api/admin/blog/media (service-role client, after AdminGuard).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'blog-media',
  'blog-media',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET public = true,
    file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];
