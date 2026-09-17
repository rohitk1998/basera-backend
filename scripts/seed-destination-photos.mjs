#!/usr/bin/env node
// Downloads one Unsplash photo per Himachal Pradesh destination (the same
// list as web/components/DistrictFilter.tsx's PLACES) and uploads it to the
// public "basera_assets" Supabase Storage bucket, so the homepage's circular
// place-filter thumbnails can point at a permanent URL instead of Unsplash's
// own (rate-limited, non-cached) source or picsum placeholders.
//
// Search query per place is `${place} Himachal Pradesh`, using Unsplash's
// /search/photos endpoint (top result). Per Unsplash API guidelines, a
// download is only "used" once its download_location endpoint is pinged —
// this script does that for every photo it actually stores.
//
// Uploaded path: destinations/{slug}.jpg (slug = lowercase, spaces -> "-").
// Idempotent: skips any place whose object already exists in the bucket
// unless --force is passed.
//
// Usage:
//   node scripts/seed-destination-photos.mjs
//   node scripts/seed-destination-photos.mjs --force
//
// Requires UNSPLASH_ACCESS_KEY and the Supabase service-role env vars this
// app already runs with (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const FORCE = process.argv.includes('--force');
const BUCKET = 'basera_assets';
const DEST_PREFIX = 'destinations';

const PLACES = [
  'Manali',
  'Shimla',
  'Dharamshala',
  'McLeodganj',
  'Kasol',
  'Bir',
  'Dalhousie',
  'Kullu',
  'Palampur',
  'Spiti Valley',
  'Chamba',
  'Kufri',
  'Manikaran',
  'Tosh',
  'Barot',
  'Chitkul',
  'Sarahan',
  'Narkanda',
];

const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
if (!UNSPLASH_ACCESS_KEY) {
  console.error('UNSPLASH_ACCESS_KEY is not set in .env — aborting.');
  process.exit(1);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set in .env — aborting.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const slugify = (place) => place.toLowerCase().trim().replace(/\s+/g, '-');

async function ensureBucketExists() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(`Failed to list buckets: ${error.message}`);

  if (buckets.some((b) => b.name === BUCKET)) return;

  const { error: createError } = await supabase.storage.createBucket(BUCKET, { public: true });
  if (createError) throw new Error(`Failed to create bucket "${BUCKET}": ${createError.message}`);
  console.log(`Created public bucket "${BUCKET}".`);
}

async function objectExists(path) {
  const dir = path.split('/').slice(0, -1).join('/');
  const filename = path.split('/').pop();
  const { data, error } = await supabase.storage.from(BUCKET).list(dir, { search: filename });
  if (error) return false;
  return data.some((f) => f.name === filename);
}

async function searchUnsplashPhotoOnce(query, { squarish } = {}) {
  const url = new URL('https://api.unsplash.com/search/photos');
  url.searchParams.set('query', query);
  url.searchParams.set('per_page', '1');
  // Squarish crops fit the circular thumbnail best, but Unsplash's search
  // combines orientation with the text query as an AND filter — a niche
  // village name has few enough matches that requiring squarish too often
  // drops the count to zero. Prefer it, but don't let it block a fallback.
  if (squarish) url.searchParams.set('orientation', 'squarish');

  const res = await fetch(url, {
    headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` },
  });
  if (!res.ok) throw new Error(`Unsplash search failed (${res.status}): ${await res.text()}`);

  const body = await res.json();
  return body.results?.[0] ?? null;
}

// Some smaller HP villages have no direct "<place> Himachal Pradesh" match
// on Unsplash — fall back to progressively looser queries rather than
// failing the whole place.
async function searchUnsplashPhoto(place) {
  const queries = [`${place} Himachal Pradesh`, `${place} India`, `${place}`, 'Himachal Pradesh mountain village'];
  for (const query of queries) {
    const squarish = await searchUnsplashPhotoOnce(query, { squarish: true });
    if (squarish) return squarish;
  }
  for (const query of queries) {
    const any = await searchUnsplashPhotoOnce(query);
    if (any) return any;
  }
  throw new Error(`No Unsplash results for "${place}" under any fallback query`);
}

// Required by Unsplash's API guidelines whenever a photo is actually used
// (not just previewed) — a fire-and-forget ping to the photo's tracked
// download endpoint.
async function triggerUnsplashDownload(downloadLocation) {
  try {
    await fetch(downloadLocation, {
      headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` },
    });
  } catch {
    // Non-fatal — the photo still uploads even if the download ping fails.
  }
}

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function run() {
  await ensureBucketExists();

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const place of PLACES) {
    const slug = slugify(place);
    const path = `${DEST_PREFIX}/${slug}.jpg`;

    if (!FORCE && (await objectExists(path))) {
      console.log(`Skipping ${place} — ${path} already exists.`);
      skipped++;
      continue;
    }

    try {
      const photo = await searchUnsplashPhoto(place);
      // 640px square gives headroom for the 80px thumbnail at up to ~3x DPI
      // (Next.js's own optimizer downsamples per-device from this source).
      const imageUrl = `${photo.urls.raw}&w=640&h=640&fit=crop&q=85`;
      const buffer = await downloadImage(imageUrl);

      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(path, buffer, { contentType: 'image/jpeg', upsert: FORCE });

      if (uploadError) throw new Error(uploadError.message);

      await triggerUnsplashDownload(photo.links.download_location);

      console.log(`Uploaded ${place} -> ${path} (Unsplash photo ${photo.id} by ${photo.user?.name ?? 'unknown'})`);
      uploaded++;
    } catch (err) {
      console.error(`Failed to seed photo for ${place}:`, err.message);
      failed++;
    }
  }

  console.log(`\nDone. Uploaded ${uploaded}, skipped ${skipped}, failed ${failed}.`);

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(`${DEST_PREFIX}/${slugify(PLACES[0])}.jpg`);
  console.log(`Example public URL shape: ${pub.publicUrl}`);
}

await run();
