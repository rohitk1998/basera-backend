#!/usr/bin/env node
// Seeds exactly 2 fully-verified host accounts with gmail.com-style test
// emails (as requested for a demo), plus 1 live listing per host.
//
// Follows the same pattern as seed-verified-users.mjs / seed-listings.mjs:
// all 5 verification_requests rows at status='verified', the matching users
// columns stamped (kyc_completed_at, bank_verified_at, selfie_uploaded_at)
// so assertVerified() and the admin UI both reflect a genuinely complete
// account, and listings written in the exact draft_data shape
// rowToListing() expects so they render everywhere a real listing would.
//
// Idempotent: reruns skip any email that already exists, and skip
// draft_data.seedTag = 'demo-verified-hosts' listings past the 1-per-host
// count already present.
//
// Requires the same .env this app already runs with (SUPABASE_DB_* vars).
import pg from 'pg';
import bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';

dotenv.config();

const SEED_PASSWORD = 'Test@123';
const seedPasswordHash = await bcrypt.hash(SEED_PASSWORD, 12);
const SEED_TAG = 'demo-verified-hosts';
const VERIFICATION_TYPES = ['identity', 'pan', 'bank', 'legal', 'selfie'];

const HOSTS = [
  {
    email: 'basera.demo.host1@gmail.com',
    fullName: 'Ananya Rawat',
    phone: '+919812340001',
    pan: 'ABCDE1234F',
    registrationNumber: 'HP/HS/1001/2025',
    upi: 'ananyarawat1@okhdfcbank',
    bankAccountNumber: '501000000001',
    bankIfsc: 'HDFC0001234',
    bankName: 'HDFC Bank',
    listing: {
      title: 'Pinewood Retreat',
      town: 'Dharamshala',
      lat: 32.219,
      lng: 76.3234,
    },
  },
  {
    email: 'basera.demo.host2@gmail.com',
    fullName: 'Karan Thakur',
    phone: '+919812340002',
    pan: 'ABCDE5678F',
    registrationNumber: 'HP/HS/1002/2025',
    upi: 'karanthakur2@okhdfcbank',
    bankAccountNumber: '501000000002',
    bankIfsc: 'HDFC0001234',
    bankName: 'HDFC Bank',
    listing: {
      title: 'Riverside Cottage',
      town: 'Old Manali',
      lat: 32.2496,
      lng: 77.1707,
    },
  },
];

const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT),
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  database: process.env.SUPABASE_DB_NAME,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

for (const h of HOSTS) {
  const { rows: existing } = await client.query(`select id from users where email = $1`, [h.email]);
  let userId;
  const now = new Date();

  if (existing.length > 0) {
    userId = existing[0].id;
    console.log(`User ${h.email} already exists (${userId}) — skipping user/verification insert.`);
  } else {
    userId = randomUUID();
    await client.query('begin');
    try {
      await client.query(
        `insert into users (
           id, full_name, email, phone, "isHost", host_kind, pan,
           registration_number, kyc_completed_at, selfie_uploaded_at,
           bank_upi, bank_account_name, bank_verified_at, created_at,
           password_hash
         ) values ($1,$2,$3,$4,true,'individual',$5,$6,$7,$7,$8,$2,$7,$7,$9)`,
        [
          userId,
          h.fullName,
          h.email,
          h.phone,
          h.pan,
          h.registrationNumber,
          now,
          h.upi,
          seedPasswordHash,
        ],
      );

      for (const type of VERIFICATION_TYPES) {
        const isBank = type === 'bank';
        const isLegal = type === 'legal';
        const isIdentity = type === 'identity';

        await client.query(
          `insert into verification_requests (
             id, user_id, verification_type, document_subtype, status,
             bank_account_number, bank_ifsc, bank_account_holder_name, bank_name,
             registration_number, submitted_at, reviewed_at, updated_at
           ) values ($1,$2,$3,$4,'verified',$5,$6,$7,$8,$9,$10,$10,$10)`,
          [
            randomUUID(),
            userId,
            type,
            isIdentity ? 'aadhaar' : null,
            isBank ? h.bankAccountNumber : null,
            isBank ? h.bankIfsc : null,
            isBank ? h.fullName : null,
            isBank ? h.bankName : null,
            isLegal ? h.registrationNumber : null,
            now,
          ],
        );
      }

      await client.query('commit');
      console.log(`Created verified host ${h.email} (${userId}).`);
    } catch (err) {
      await client.query('rollback');
      console.error(`Failed to seed host ${h.email}:`, err.message);
      continue;
    }
  }

  const { rows: existingListing } = await client.query(
    `select id from listings where host_id = $1 and draft_data->>'seedTag' = $2`,
    [userId, SEED_TAG],
  );
  if (existingListing.length > 0) {
    console.log(`Listing for ${h.email} already exists — skipping.`);
    continue;
  }

  const propertyDetails = {
    title: h.listing.title,
    propertyType: 'cottage',
    beds: '2BHK',
    bedrooms: 2,
    bathrooms: 1,
    maxGuests: 4,
    town: h.listing.town,
    fullAddress: `${h.listing.title}, ${h.listing.town}, Himachal Pradesh, India`,
    lat: h.listing.lat,
    lng: h.listing.lng,
    description: `${h.listing.title} is a well-kept home in ${h.listing.town}, ideal for long stays. Verified host, direct booking, zero commission.`,
    theSpace: '',
    guestAccess: '',
    photos: [],
    dailyBaseRate: 1500,
    weeklyDiscountPct: 10,
    monthlyDiscountPct: 25,
    minDays: 30,
    availableFrom: new Date().toISOString().slice(0, 10),
    billsIncluded: 'all',
    checkIn: '12:00 pm – 9:00 pm',
    checkOut: 'Before 11:00 am',
    pets: false,
    smoking: false,
    cancellation: 'moderate',
    categories: ['long', 'entire', 'quiet'],
    amenities: ['Wifi', 'Workspace', 'Power backup', 'Kitchen', 'Hot water', 'Mountain views'],
  };

  const draftData = {
    seedTag: SEED_TAG,
    property_details: propertyDetails,
    telemetry: { walkthroughPassed: true },
    banking: { upi: h.upi, name: h.fullName },
    legal: { registrationNumber: h.registrationNumber },
    media: {},
    trustScore: 95,
  };

  await client.query(
    `insert into listings (id, host_id, status, draft_data, visit_status, created_at, updated_at)
     values ($1, $2, 'live', $3, 'passed', now(), now())`,
    [randomUUID(), userId, JSON.stringify(draftData)],
  );
  console.log(`Created live listing "${h.listing.title}" for ${h.email}.`);
}

console.log(`\nDone. Password for both demo host accounts: ${SEED_PASSWORD}`);
await client.end();
