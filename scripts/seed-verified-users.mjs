#!/usr/bin/env node
// Seeds N fully-verified test profiles — guest/host accounts that can log
// in via POST /api/auth/login (email + SEED_PASSWORD below), the real
// email+password path for guest/host accounts distinct from admin login
// (see auth.controller.ts login()). Each profile gets all 5
// verification_requests rows (identity/pan/bank/legal/selfie) already at
// status='verified', plus the matching profiles columns stamped
// (kyc_completed_at, bank_verified_at, selfie_uploaded_at,
// registration_number, pan) so assertVerified() and the admin UI both
// reflect a genuinely complete account — not just a verification_requests
// row with nothing backing it.
//
// Idempotent by email prefix: reruns skip any seed-* email that already
// exists, so this is safe to run again to top up to a larger count.
//
// Usage:
//   node scripts/seed-verified-users.mjs [count]
//   node scripts/seed-verified-users.mjs 100
//
// Requires the same .env this app already runs with (SUPABASE_DB_* vars).
import pg from 'pg';
import bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';

dotenv.config();

const count = Number(process.argv[2] ?? 100);
if (!Number.isInteger(count) || count < 1 || count > 5000) {
  console.error('Usage: node scripts/seed-verified-users.mjs [count]  (1-5000, default 100)');
  process.exit(1);
}

const SEED_PASSWORD = 'Test@123';
const seedPasswordHash = await bcrypt.hash(SEED_PASSWORD, 12);

const EMAIL_PREFIX = 'seed-verified-';
const EMAIL_DOMAIN = 'basera.test';
const PHONE_PREFIX = '+9190000';
const VERIFICATION_TYPES = ['identity', 'pan', 'bank', 'legal', 'selfie'];

const FIRST_NAMES = [
  'Aanya', 'Vihaan', 'Diya', 'Arjun', 'Myra', 'Reyansh', 'Anika', 'Kabir',
  'Ishaan', 'Saanvi', 'Advait', 'Riya', 'Vivaan', 'Anaya', 'Aryan', 'Kiara',
];
const LAST_NAMES = [
  'Sharma', 'Verma', 'Gupta', 'Kapoor', 'Mehta', 'Iyer', 'Nair', 'Reddy',
  'Chauhan', 'Joshi', 'Malhotra', 'Bhatia', 'Rao', 'Desai', 'Pillai', 'Singh',
];

function randomOf(arr, seedIndex) {
  return arr[seedIndex % arr.length];
}

function pad(n, width) {
  return String(n).padStart(width, '0');
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

const { rows: existingRows } = await client.query(
  `select email from users where email like $1`,
  [`${EMAIL_PREFIX}%@${EMAIL_DOMAIN}`],
);
const existingEmails = new Set(existingRows.map((r) => r.email));

let created = 0;
let skipped = 0;

for (let i = 1; i <= count; i++) {
  const email = `${EMAIL_PREFIX}${pad(i, 4)}@${EMAIL_DOMAIN}`;
  if (existingEmails.has(email)) {
    skipped++;
    continue;
  }

  const userId = randomUUID();
  const firstName = randomOf(FIRST_NAMES, i);
  const lastName = randomOf(LAST_NAMES, i + 7);
  const fullName = `${firstName} ${lastName}`;
  const phone = `${PHONE_PREFIX}${pad(i, 4)}`;
  const isHost = i % 2 === 0;
  const registrationNumber = `HP/HS/${pad(1000 + i, 4)}/2025`;
  const pan = `ABCDE${pad(i % 10000, 4)}F`;
  const now = new Date();

  await client.query('begin');
  try {
    await client.query(
      `insert into users (
         id, full_name, email, phone, "isHost", host_kind, pan,
         registration_number, kyc_completed_at, selfie_uploaded_at,
         bank_upi, bank_account_name, bank_verified_at, created_at,
         password_hash
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$9,$9,$12)`,
      [
        userId,
        fullName,
        email,
        phone,
        isHost,
        isHost ? 'individual' : null,
        pan,
        registrationNumber,
        now,
        `${firstName.toLowerCase()}${i}@okhdfcbank`,
        fullName,
        seedPasswordHash,
      ],
    );

    for (const type of VERIFICATION_TYPES) {
      // legal/bank carry their own type-specific fields; identity/pan/selfie
      // don't need document_subtype set for this backfill (admin detail view
      // treats a null subtype as "not applicable" for those types already).
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
          isBank ? `50100${pad(i, 6)}` : null,
          isBank ? 'HDFC0001234' : null,
          isBank ? fullName : null,
          isBank ? 'HDFC Bank' : null,
          isLegal ? registrationNumber : null,
          now,
        ],
      );
    }

    await client.query('commit');
    created++;
  } catch (err) {
    await client.query('rollback');
    console.error(`Failed to seed user ${i} (${email}):`, err.message);
  }
}

console.log(
  `Done. Created ${created} new verified profiles, skipped ${skipped} already existing. ` +
    `Password for all seed-* accounts: ${SEED_PASSWORD}`,
);
await client.end();
