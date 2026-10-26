#!/usr/bin/env node
// Seeds N fully-verified host accounts with exactly ONE live listing each, for
// manually testing the listing and booking flows. Guests/hosts have no password
// login in this app: sign in with the email OTP (POST /api/auth/email-otp/send,
// then /verify); the yopmail.com inboxes are publicly readable. Each account
// passes assertKycVerified
// (verified identity request + selfie_uploaded_at), so it can host AND book.
//
// Written against the current schema (kyc_completed_at / registration_number /
// the 'legal' verification type were dropped in 20260923_remove_legal_verification;
// scripts/seed-verified-users.mjs still uses them and no longer runs).
//
// Everything is tagged: users by email prefix `flowtest-`, listings by
// draft_data.seedTag = 'flow-test'. Idempotent (existing emails are skipped) and
// reversible with --clean.
//
// Usage:
//   node scripts/seed-flow-test.mjs [count] [--dry-run]
//   node scripts/seed-flow-test.mjs --clean
import pg from 'pg';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';

dotenv.config({ quiet: true });

const args = process.argv.slice(2);
const CLEAN = args.includes('--clean');
const DRY = args.includes('--dry-run');
const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 1000);
if (!Number.isInteger(count) || count < 1 || count > 5000) {
  console.error('Usage: node scripts/seed-flow-test.mjs [count 1-5000] [--dry-run] | --clean');
  process.exit(1);
}

const EMAIL_PREFIX = 'flowtest-';
const EMAIL_DOMAIN = 'yopmail.com';
const SEED_TAG = 'flow-test';
const BATCH = 200;

const FIRST = ['Aanya', 'Vihaan', 'Diya', 'Arjun', 'Myra', 'Reyansh', 'Anika', 'Kabir', 'Ishaan', 'Saanvi', 'Advait', 'Riya', 'Vivaan', 'Anaya', 'Aryan', 'Kiara'];
const LAST = ['Sharma', 'Verma', 'Gupta', 'Kapoor', 'Mehta', 'Iyer', 'Nair', 'Reddy', 'Chauhan', 'Joshi', 'Malhotra', 'Bhatia', 'Rao', 'Desai', 'Pillai', 'Singh'];
// district/tehsil use the HP_DISTRICTS spelling so the district and place facets pick these up.
const PLACES = [
  { town: 'Dharamshala', tehsil: 'Dharamshala', district: 'Kangra', lat: 32.219, lng: 76.3234 },
  { town: 'Old Manali', tehsil: 'Manali', district: 'Kullu', lat: 32.2496, lng: 77.1707 },
  { town: 'Bir', tehsil: 'Baijnath', district: 'Kangra', lat: 32.0463, lng: 76.7185 },
  { town: 'Kasol', tehsil: 'Bhuntar', district: 'Kullu', lat: 32.0104, lng: 77.3145 },
  { town: 'Palampur', tehsil: 'Palampur', district: 'Kangra', lat: 32.1122, lng: 76.5362 },
];
const TYPES = ['cottage', 'flat', 'studio', 'homestay', 'cabin'];
const BEDS = ['Studio', '1BHK', '2BHK', '3BHK'];
const CANCEL = ['flexible', 'moderate', 'firm'];
const BILLS = ['all', 'electricity_extra', 'none'];
const CATS = ['long', 'entire', 'work', 'views', 'quiet'];
const AMENITIES = ['Wifi', 'Workspace', 'Power backup', 'Kitchen', 'Dining table', 'Hot water', 'Room heater', 'Attached bathroom', 'Washing machine', 'Extra bedding', 'Mountain views', 'Balcony', 'Parking', 'Garden', 'Smoke alarm', 'First aid kit'];
const ADJ = ['Sunview', 'Pinewood', 'Riverside', 'Valley', 'Cedar', 'Misty', 'Highland', 'Orchard', 'Willow', 'Alpine'];
const NOUN = ['Cottage', 'Retreat', 'Homestay', 'Cabin', 'Nest', 'House', 'Villa', 'Loft', 'Bungalow', 'Studio'];

const pick = (a, i) => a[i % a.length];
const pad = (n, w) => String(n).padStart(w, '0');
const some = (a, i, min, max) => {
  const n = min + (i % (max - min + 1));
  return [...new Set(Array.from({ length: n }, (_, k) => a[(i + k) % a.length]))];
};
const jitter = (base, spread, seed) => {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return base + (x - Math.floor(x) - 0.5) * 2 * spread;
};
const multiInsert = (table, cols, rows, suffix = '') => {
  const values = [];
  const ph = rows.map((r) => {
    const s = values.length;
    values.push(...r);
    return `(${r.map((_, k) => (typeof r[k] === 'object' && r[k]?.sql ? r[k].sql : `$${s + k + 1}`)).join(',')})`;
  });
  return { text: `insert into ${table} (${cols.join(',')}) values ${ph.join(',')}${suffix}`, values };
};

const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT),
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  database: process.env.SUPABASE_DB_NAME,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
const like = `${EMAIL_PREFIX}%@${EMAIL_DOMAIN}`;

if (CLEAN) {
  await client.query('begin');
  const l = await client.query(`delete from listings where host_id in (select id from users where email like $1)`, [like]);
  const u = await client.query(`delete from users where email like $1`, [like]); // verification_requests cascade
  await client.query('commit');
  console.log(`Removed ${l.rowCount} listings and ${u.rowCount} users.`);
  await client.end();
  process.exit(0);
}

const { rows: existing } = await client.query(`select email from users where email like $1`, [like]);
const have = new Set(existing.map((r) => r.email));
const todo = [];
for (let i = 1; i <= count; i++) if (!have.has(`${EMAIL_PREFIX}${pad(i, 4)}@${EMAIL_DOMAIN}`)) todo.push(i);
console.log(`Target ${count}: ${have.size} already exist, creating ${todo.length}.`);
if (DRY || todo.length === 0) {
  await client.end();
  process.exit(0);
}

let created = 0;
for (let b = 0; b < todo.length; b += BATCH) {
  const now = new Date();
  const users = [], vr = [], ls = [];
  for (const i of todo.slice(b, b + BATCH)) {
    const id = randomUUID();
    const first = pick(FIRST, i), last = pick(LAST, i + 7);
    const name = `${first} ${last}`;
    users.push([id, name, `${EMAIL_PREFIX}${pad(i, 4)}@${EMAIL_DOMAIN}`, `+9177${pad(i, 8)}`, true, 'individual', `ABCDE${pad(i % 10000, 4)}F`, now, `${first.toLowerCase()}${i}@okhdfcbank`, name, now, now]);
    for (const type of ['identity', 'pan', 'bank', 'selfie']) {
      vr.push([randomUUID(), id, type, type === 'identity' ? 'aadhaar' : null, 'verified',
        type === 'bank' ? `50100${pad(i, 6)}` : null, type === 'bank' ? 'HDFC0001234' : null,
        type === 'bank' ? name : null, type === 'bank' ? 'HDFC Bank' : null, now, now, now]);
    }
    const p = pick(PLACES, i);
    const title = `${pick(ADJ, i)} ${pick(NOUN, i + 5)} #${i}`;
    const type = pick(TYPES, i);
    const draft = {
      seedTag: SEED_TAG,
      trustScore: 80 + (i % 20),
      property_details: {
        title, propertyType: type, beds: pick(BEDS, i + 3), bedrooms: 1 + (i % 4), bathrooms: 1 + (i % 3),
        maxGuests: 2 + (i % 6), town: p.town, tehsil: p.tehsil, district: p.district,
        fullAddress: `${title}, ${p.town}, ${p.district}, Himachal Pradesh, India`,
        lat: jitter(p.lat, 0.06, i), lng: jitter(p.lng, 0.06, i + 1000),
        description: `${title} is a well-kept ${type} in ${p.town}, ideal for long stays. Verified host, direct booking.`,
        theSpace: '', guestAccess: '', photos: [],
        dailyBaseRate: 800 + (i % 40) * 150, weeklyDiscountPct: 5 + (i % 15), monthlyDiscountPct: 20 + (i % 20),
        minDays: [1, 7, 30][i % 3], availableFrom: new Date().toISOString().slice(0, 10),
        billsIncluded: pick(BILLS, i), checkIn: '12:00 pm – 9:00 pm', checkOut: 'Before 11:00 am',
        pets: i % 3 === 0, smoking: i % 5 === 0, cancellation: pick(CANCEL, i),
        categories: some(CATS, i, 1, 3), amenities: some(AMENITIES, i, 4, 8),
      },
      telemetry: { walkthroughPassed: true },
      banking: { upi: `${first.toLowerCase()}${i}@okhdfcbank`, name },
      media: {},
    };
    ls.push([randomUUID(), id, JSON.stringify(draft)]);
  }
  await client.query('begin');
  try {
    const u = multiInsert('users', ['id', 'full_name', 'email', 'phone', '"isHost"', 'host_kind', 'pan', 'selfie_uploaded_at', 'bank_upi', 'bank_account_name', 'bank_verified_at', 'created_at'], users);
    await client.query(u.text, u.values);
    const v = multiInsert('verification_requests', ['id', 'user_id', 'verification_type', 'document_subtype', 'status', 'bank_account_number', 'bank_ifsc', 'bank_account_holder_name', 'bank_name', 'submitted_at', 'reviewed_at', 'updated_at'], vr);
    await client.query(v.text, v.values);
    const l = multiInsert('listings', ['id', 'host_id', 'draft_data', 'status', 'visit_status', 'created_at', 'updated_at'],
      ls.map((r) => [r[0], r[1], r[2], 'live', 'passed', now, now]));
    await client.query(l.text, l.values);
    await client.query('commit');
    created += users.length;
    console.log(`  ...${created}/${todo.length}`);
  } catch (err) {
    await client.query('rollback');
    console.error(`Batch at ${todo[b]} failed, rolled back:`, err.message);
    process.exitCode = 1;
    break;
  }
}
console.log(`Done. Created ${created} users + ${created} listings. Sign in via email OTP (inbox: yopmail.com/?login=flowtest-NNNN).`);
await client.end();
