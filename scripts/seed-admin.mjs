#!/usr/bin/env node
// Creates (or resets the password of) an admin account.
//
// There is no self-serve way to become an admin — admins are a manually
// provisioned profiles.role = 'admin' flag, and this script is the only
// place that sets password_hash. Run it by hand, once, per admin:
//
//   node scripts/seed-admin.mjs "ops@basera.in" "a strong password"
//
// Requires the same .env this app already runs with (SUPABASE_DB_* vars).
import pg from 'pg';
import bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';

dotenv.config();

const [, , email, password] = process.argv;

if (!email || !password) {
  console.error('Usage: node scripts/seed-admin.mjs <email> <password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
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

const passwordHash = await bcrypt.hash(password, 12);

const { rows: existing } = await client.query('select id from users where email = $1', [email]);

if (existing.length > 0) {
  await client.query(
    `update users set role = 'admin', password_hash = $2 where id = $1`,
    [existing[0].id, passwordHash],
  );
  console.log(`Updated existing profile ${existing[0].id} — role set to admin, password reset.`);
} else {
  const id = randomUUID();
  await client.query(
    `insert into users (id, email, role, password_hash, "isHost")
     values ($1, $2, 'admin', $3, false)`,
    [id, email, passwordHash],
  );
  console.log(`Created new admin profile ${id} for ${email}.`);
}

await client.end();
