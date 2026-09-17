#!/usr/bin/env node
// Seeds N live listings, owned by the seed-verified-users.mjs accounts
// (seed-verified-%@basera.test) — round-robins host_id across whichever of
// those profiles already exist, so run seed-verified-users.mjs first (or
// with a high enough count) if this reports 0 host candidates.
//
// draft_data is written in the exact shape rowToListing() (listing-mapper.ts)
// expects — property_details/telemetry/banking/legal/media — same as a real
// submitFull() write, so these listings render correctly everywhere a real
// one would: the public listing page, RowCard/MapExplorer, and the admin
// properties list. Photos are omitted (propStep.photos left empty) so the
// mapper's own picsum-placeholder fallback kicks in — no real upload needed
// for bulk test data, matching how draft rows without photos already behave.
//
// Idempotent: tags every seeded row's draft_data.seedTag = 'bulk-listings'
// and skips re-seeding past whatever count already exists under that tag,
// so reruns top up rather than duplicate.
//
// Usage:
//   node scripts/seed-listings.mjs [count]
//   node scripts/seed-listings.mjs 5000
//
// Requires the same .env this app already runs with (SUPABASE_DB_* vars).
import pg from 'pg';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';

dotenv.config();

const count = Number(process.argv[2] ?? 5000);
if (!Number.isInteger(count) || count < 1 || count > 50000) {
  console.error('Usage: node scripts/seed-listings.mjs [count]  (1-50000, default 5000)');
  process.exit(1);
}

const SEED_TAG = 'bulk-listings';

const TOWNS = [
  { name: 'Dharamshala', lat: 32.219, lng: 76.3234 },
  { name: 'Old Manali', lat: 32.2496, lng: 77.1707 },
  { name: 'Bir', lat: 32.0463, lng: 76.7185 },
  { name: 'Kasol', lat: 32.0104, lng: 77.3145 },
  { name: 'Palampur', lat: 32.1122, lng: 76.5362 },
];

const PROPERTY_TYPES = ['cottage', 'flat', 'studio', 'homestay', 'cabin'];
const BEDS = ['Studio', '1BHK', '2BHK', '3BHK'];
const CANCELLATION = ['flexible', 'moderate', 'firm'];
const BILLS = ['all', 'electricity_extra', 'none'];
const CATEGORY_POOL = ['long', 'entire', 'work', 'views', 'quiet'];
const AMENITY_POOL = [
  'Wifi', 'Workspace', 'Power backup', 'Kitchen', 'Dining table', 'Hot water',
  'Room heater', 'Attached bathroom', 'Washing machine', 'Extra bedding',
  'Mountain views', 'Balcony', 'Parking', 'Garden', 'Smoke alarm', 'First aid kit',
];

const ADJECTIVES = ['Sunview', 'Pinewood', 'Riverside', 'Valley', 'Cedar', 'Misty', 'Highland', 'Orchard', 'Willow', 'Alpine'];
const NOUNS = ['Cottage', 'Retreat', 'Homestay', 'Cabin', 'Nest', 'House', 'Villa', 'Loft', 'Bungalow', 'Studio'];

function pick(arr, i) {
  return arr[i % arr.length];
}

function pickSome(arr, i, min, max) {
  const n = min + (i % (max - min + 1));
  const start = i % arr.length;
  const out = [];
  for (let k = 0; k < n; k++) out.push(arr[(start + k) % arr.length]);
  return Array.from(new Set(out));
}

function jitter(base, spread, seed) {
  // Deterministic pseudo-random jitter from the seed index — keeps pins
  // spread around each town centre instead of stacking on one point.
  const pseudo = Math.sin(seed * 12.9898) * 43758.5453;
  const frac = pseudo - Math.floor(pseudo);
  return base + (frac - 0.5) * 2 * spread;
}

const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT),
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  database: process.env.SUPABASE_DB_NAME,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

const { rows: hosts } = await client.query(
  `select id from users where email like $1 order by email`,
  [`seed-verified-%@basera.test`],
);

if (hosts.length === 0) {
  console.error('No seed-verified-* profiles found — run scripts/seed-verified-users.mjs first.');
  await client.end();
  process.exit(1);
}

const { rows: existingCountRows } = await client.query(
  `select count(*) from listings where draft_data->>'seedTag' = $1`,
  [SEED_TAG],
);
const alreadySeeded = Number(existingCountRows[0].count);

if (alreadySeeded >= count) {
  console.log(`Already have ${alreadySeeded} seeded listings (>= requested ${count}). Nothing to do.`);
  await client.end();
  process.exit(0);
}

const toCreate = count - alreadySeeded;
console.log(`Creating ${toCreate} listings (already have ${alreadySeeded}, target ${count})...`);

let created = 0;

for (let i = alreadySeeded; i < count; i++) {
  const host = hosts[i % hosts.length];
  const town = pick(TOWNS, i);
  const propertyType = pick(PROPERTY_TYPES, i);
  const beds = pick(BEDS, i + 3);
  const bedrooms = 1 + (i % 4);
  const bathrooms = 1 + (i % 3);
  const maxGuests = 2 + (i % 6);
  const dailyBaseRate = 800 + (i % 40) * 150;
  const title = `${pick(ADJECTIVES, i)} ${pick(NOUNS, i + 5)} #${i + 1}`;
  const lat = jitter(town.lat, 0.06, i);
  const lng = jitter(town.lng, 0.06, i + 1000);
  const categories = pickSome(CATEGORY_POOL, i, 1, 3);
  const amenities = pickSome(AMENITY_POOL, i, 4, 8);

  const propertyDetails = {
    title,
    propertyType,
    beds,
    bedrooms,
    bathrooms,
    maxGuests,
    town: town.name,
    fullAddress: `${title}, ${town.name}, Himachal Pradesh, India`,
    lat,
    lng,
    description: `${title} is a well-kept ${propertyType} in ${town.name}, ideal for long stays. Verified host, direct booking, zero commission.`,
    theSpace: '',
    guestAccess: '',
    photos: [],
    dailyBaseRate,
    weeklyDiscountPct: 5 + (i % 15),
    monthlyDiscountPct: 20 + (i % 20),
    minDays: [1, 7, 30][i % 3],
    availableFrom: new Date().toISOString().slice(0, 10),
    billsIncluded: pick(BILLS, i),
    checkIn: '12:00 pm – 9:00 pm',
    checkOut: 'Before 11:00 am',
    pets: i % 3 === 0,
    smoking: i % 5 === 0,
    cancellation: pick(CANCELLATION, i),
    categories,
    amenities,
  };

  const draftData = {
    seedTag: SEED_TAG,
    property_details: propertyDetails,
    telemetry: { walkthroughPassed: true },
    banking: { upi: `seedhost${i}@okhdfcbank`, name: 'Seed Host' },
    legal: { registrationNumber: `HP/HS/${2000 + (i % 4000)}/2025` },
    plan: { plan: 'listed' },
    media: {},
    trustScore: 80 + (i % 20),
  };

  await client.query(
    `insert into listings (id, host_id, status, draft_data, visit_status, created_at, updated_at)
     values ($1, $2, 'live', $3, 'passed', now(), now())`,
    [randomUUID(), host.id, JSON.stringify(draftData)],
  );

  created++;
  if (created % 500 === 0) {
    console.log(`  ...${created}/${toCreate} created`);
  }
}

console.log(`Done. Created ${created} new listings across ${hosts.length} seeded hosts.`);
await client.end();
