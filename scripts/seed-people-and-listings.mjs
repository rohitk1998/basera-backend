#!/usr/bin/env node
// Seeds realistic test data: N users (a mix of fully verified, KYC-verified guests,
// partly verified and unverified) plus ~M listings owned by the FULLY verified hosts.
//
// NAMES come from real public datasets (downloaded separately, passed with --names-dir):
//   - US first names:   Social Security Administration baby-name counts (hadley/data-baby-names)
//   - US surnames:      US Census Bureau 2010 surnames file
//   - Indian first names + surnames: public-record Indian name lists with gender
//     (mbejda gists) plus the Indian_Names.csv first-name list (balasahebgulave)
// First names and surnames are sampled independently and combined, so no real
// person's full name is reproduced; every full name and every first name is unique.
//
// "Fully verified" means what the app's gates mean today: an approved identity
// document + approved selfie (the shared KYC gate) and, for hosts, a verified payout
// account (admin go-live requires it). Only those hosts get listings.
//
// Accounts are DATA ONLY: there is no password login for guests/hosts in this app, and
// emails use the reserved example.com/.org/.net domains, which never deliver mail.
//
// Usage:
//   node scripts/seed-people-and-listings.mjs --names-dir <dir> [--users 500] [--listings 500] [--seed 20261009] [--dry-run]
//   node scripts/seed-people-and-listings.mjs --clean --yes     # remove everything this script seeded
//
// Requires the same .env the app runs with (SUPABASE_DB_* vars) and a built dist/ (for the
// Himachal location data): run `npm run build` or have `nest start` compiled it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import * as dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '.env'), quiet: true });
const require = createRequire(import.meta.url);

// ───────────────────────────── args ─────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const NAMES_DIR = opt('names-dir', null);
const USER_COUNT = Number(opt('users', 500));
const LISTING_TARGET = Number(opt('listings', 500));
const SEED = Number(opt('seed', 20261009));
const DRY = flag('dry-run');
const SEED_TAG = 'seed-people-v1';
const EMAIL_DOMAINS = ['example.com', 'example.org', 'example.net'];

// ───────────────────────────── db ─────────────────────────────
const connect = async () => {
  const c = new pg.Client({
    host: process.env.SUPABASE_DB_HOST,
    port: Number(process.env.SUPABASE_DB_PORT),
    user: process.env.SUPABASE_DB_USER,
    password: process.env.SUPABASE_DB_PASSWORD,
    database: process.env.SUPABASE_DB_NAME,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  return c;
};

if (flag('clean')) {
  if (!flag('yes')) {
    console.error('--clean deletes every user/listing this script seeded. Re-run with --clean --yes to confirm.');
    process.exit(1);
  }
  const c = await connect();
  await c.query('begin');
  try {
    const ids = (
      await c.query(`select id from users where email ~ '@example\\.(com|org|net)$'`)
    ).rows.map((r) => r.id);
    const l = await c.query(`delete from listings where draft_data->>'seedTag' = $1 or host_id = any($2::uuid[])`, [SEED_TAG, ids]);
    const v = await c.query(`delete from verification_requests where user_id = any($1::uuid[])`, [ids]);
    const u = await c.query(`delete from users where id = any($1::uuid[])`, [ids]);
    await c.query('commit');
    console.log(`Removed ${u.rowCount} users, ${v.rowCount} verification rows, ${l.rowCount} listings.`);
  } catch (e) {
    await c.query('rollback');
    console.error('Rolled back:', e.message);
    process.exitCode = 1;
  }
  await c.end();
  process.exit();
}

if (!NAMES_DIR) {
  console.error('Missing --names-dir <dir> (the folder holding the downloaded name datasets).');
  process.exit(1);
}
if (!Number.isInteger(USER_COUNT) || USER_COUNT < 20 || USER_COUNT > 5000) {
  console.error('--users must be an integer between 20 and 5000.');
  process.exit(1);
}

// ───────────────────────────── rng ─────────────────────────────
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const pickN = (arr, n) => shuffle(arr).slice(0, Math.min(n, arr.length));
function weighted(items, weightOf) {
  const total = items.reduce((s, x) => s + weightOf(x), 0);
  let r = rnd() * total;
  for (const x of items) {
    r -= weightOf(x);
    if (r <= 0) return x;
  }
  return items[items.length - 1];
}
const pickWeighted = (pairs) => weighted(pairs, (p) => p[1])[0];

// ───────────────────────────── names ─────────────────────────────
const readLines = (f) => fs.readFileSync(path.join(NAMES_DIR, f), 'utf8').split(/\r?\n/);
const title = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function loadIndianNames() {
  // Public-record lists: "name,gender,race" — first token = given name, last token = surname.
  const gist = (file, gender) =>
    readLines(file)
      .slice(1)
      .map((l) => l.split(',')[0].trim().toLowerCase())
      .filter(Boolean)
      .map((n) => ({ tokens: n.split(/\s+/), gender }));
  const rows = [...gist('Indian-Male-Names.csv', 'm'), ...gist('Indian-Female-Names.csv', 'f')];

  const curated = new Set(
    readLines('indian_first.csv')
      .slice(1)
      .map((l) => (l.split(',')[1] || '').trim().toLowerCase())
      .filter(Boolean),
  );

  const firstCount = new Map();
  const lastByGender = { m: new Map(), f: new Map() };
  for (const { tokens, gender } of rows) {
    const first = tokens[0];
    if (/^[a-z]{3,12}$/.test(first)) firstCount.set(`${gender}:${first}`, (firstCount.get(`${gender}:${first}`) || 0) + 1);
    if (tokens.length >= 2) {
      const last = tokens[tokens.length - 1];
      if (/^[a-z]{3,}$/.test(last)) lastByGender[gender].set(last, (lastByGender[gender].get(last) || 0) + 1);
    }
  }

  // Surnames: seen as a last name 3+ times, and used more as a surname than as a given name.
  const surnameCount = new Map();
  for (const g of ['m', 'f']) for (const [s, c] of lastByGender[g]) surnameCount.set(s, (surnameCount.get(s) || 0) + c);
  const asFirst = (s) => (firstCount.get(`m:${s}`) || 0) + (firstCount.get(`f:${s}`) || 0);
  const surnames = { m: [], f: [] };
  for (const [s, total] of surnameCount) {
    if (total < 3 || asFirst(s) > total) continue;
    const f = lastByGender.f.get(s) || 0;
    const ratioF = f / total;
    const w = Math.sqrt(total); // flatten the Kumar/Singh dominance
    if (ratioF < 0.1) surnames.m.push([s, w]);
    else if (ratioF > 0.9) surnames.f.push([s, w]);
    else {
      surnames.m.push([s, w]);
      surnames.f.push([s, w]);
    }
  }

  // Given names: a name counts when it is in the curated list or seen 3+ times, and is not a surname-style token.
  const surnameSet = new Set([...surnameCount.keys()].filter((s) => surnameCount.get(s) >= 8));
  const firsts = { m: [], f: [] };
  for (const [k, c] of firstCount) {
    const [g, name] = [k[0], k.slice(2)];
    if (!/[aeiou]/.test(name) || /(.)\1\1/.test(name) || surnameSet.has(name)) continue;
    if ((curated.has(name) && c >= 2) || c >= 6) firsts[g].push([name, 1 + Math.log(c + 1)]);
  }
  return { firsts, surnames };
}

function loadUsNames() {
  // SSA baby names (year,"name",percent,"sex"): average share 1955–1995 (today's adults).
  const acc = new Map();
  for (const line of readLines('us_first.csv').slice(1)) {
    const m = /^(\d{4}),"([^"]+)",([\d.]+),"(boy|girl)"$/.exec(line);
    if (!m) continue;
    const year = Number(m[1]);
    if (year < 1955 || year > 1995) continue;
    const key = `${m[4] === 'boy' ? 'm' : 'f'}:${m[2]}`;
    acc.set(key, (acc.get(key) || 0) + Number(m[3]));
  }
  const firsts = { m: [], f: [] };
  for (const g of ['m', 'f']) {
    const list = [...acc.entries()]
      .filter(([k]) => k[0] === g)
      .map(([k, v]) => [k.slice(2), v])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 900);
    firsts[g] = list.filter(([n]) => /^[A-Za-z]{3,12}$/.test(n)).map(([n, v]) => [n, Math.sqrt(v)]);
  }
  // Census 2010 surnames: top 3000 by rank.
  const surnames = [];
  for (const line of readLines('census/Names_2010Census.csv').slice(1)) {
    const parts = line.split(',');
    const rank = Number(parts[1]);
    if (!(rank >= 1 && rank <= 3000)) continue;
    let n = parts[0].toLowerCase();
    n = n.replace(/^(mc)([a-z])/, (_, a, b) => 'Mc' + b.toUpperCase()).replace(/^(o')([a-z])/, (_, a, b) => "O'" + b.toUpperCase());
    n = n.replace(/-([a-z])/g, (_, c) => '-' + c.toUpperCase());
    if (!/^[A-Za-z'-]{3,}$/.test(n.replace(/^./, 'A'))) continue;
    surnames.push([n.charAt(0) === n.charAt(0).toUpperCase() ? n : title(n), Math.sqrt(Number(parts[2]) || 1)]);
  }
  return { firsts, surnames };
}

const indian = loadIndianNames();
const us = loadUsNames();

const usedFull = new Set();
const usedFirst = new Set();
const surnameUses = new Map();
const SURNAME_CAP = 3;

function drawName(origin, gender) {
  const pool = origin === 'in' ? indian : us;
  const firstPool = pool.firsts[gender];
  const lastPool = origin === 'in' ? pool.surnames[gender] : pool.surnames;
  for (let tries = 0; tries < 400; tries++) {
    const first = weighted(firstPool, (x) => x[1])[0];
    const last = weighted(lastPool, (x) => x[1])[0];
    const f = origin === 'in' ? title(first) : first;
    const l = origin === 'in' ? title(last) : last;
    const full = `${f} ${l}`;
    const uses = surnameUses.get(l.toLowerCase()) || 0;
    if (usedFull.has(full.toLowerCase()) || usedFirst.has(f.toLowerCase())) continue;
    if (uses >= (origin === 'in' && ['singh', 'kumar', 'sharma'].includes(l.toLowerCase()) ? 10 : SURNAME_CAP)) continue;
    usedFull.add(full.toLowerCase());
    usedFirst.add(f.toLowerCase());
    surnameUses.set(l.toLowerCase(), uses + 1);
    return { first: f, last: l, full };
  }
  throw new Error(`could not draw a unique ${origin} ${gender} name`);
}

// ───────────────────────────── places ─────────────────────────────
// district/tehsil are validated against the app's own Himachal data (dist build) at run time.
const PLACES = [
  { place: 'Manali', district: 'Kullu', tehsil: 'Manali', lat: 32.2432, lng: 77.1892, pin: '175131', tier: 1, vibe: ['river', 'snow', 'deodar', 'cafes', 'adventure'], localities: ['Old Manali', 'Vashisht', 'Aleo', 'Prini', 'Hadimba Road', 'Sunny Side', 'Burua'], landmarks: ['Near Hadimba Temple', 'Near Mall Road', 'Near Manu Temple', 'Near Vashisht hot springs'] },
  { place: 'Naggar', district: 'Kullu', tehsil: 'Kullu', lat: 32.1138, lng: 77.1731, pin: '175130', tier: 2, vibe: ['castle', 'orchards', 'deodar', 'art'], localities: ['Naggar', 'Jagatsukh', 'Rumsu', 'Chanalsari'], landmarks: ['Near Naggar Castle', 'Near Roerich Art Gallery', 'Near Tripura Sundari Temple'] },
  { place: 'Kullu', district: 'Kullu', tehsil: 'Kullu', lat: 31.9578, lng: 77.1095, pin: '175101', tier: 3, vibe: ['river', 'town', 'temple'], localities: ['Dhalpur', 'Akhara Bazaar', 'Sarvari', 'Raison'], landmarks: ['Near Dhalpur Maidan', 'Near Raghunath Temple', 'Near Beas river'] },
  { place: 'Bhuntar', district: 'Kullu', tehsil: 'Bhuntar', lat: 31.8781, lng: 77.1521, pin: '175125', tier: 3, vibe: ['river', 'valley', 'village'], localities: ['Bhuntar', 'Shamshi', 'Katrain'], landmarks: ['Near Kullu-Manali airport road', 'Near Parvati valley turn'] },
  { place: 'Kasol', district: 'Kullu', tehsil: 'Bhuntar', lat: 32.0100, lng: 77.3150, pin: '175105', tier: 1, vibe: ['river', 'cafes', 'trek', 'deodar'], localities: ['Kasol', 'Chalal', 'Rasol', 'Katagla'], landmarks: ['Near Parvati river bridge', 'Near Kasol market', 'Near Chalal trail'] },
  { place: 'Manikaran', district: 'Kullu', tehsil: 'Bhuntar', lat: 32.0304, lng: 77.3490, pin: '175105', tier: 2, vibe: ['hotsprings', 'river', 'temple', 'village'], localities: ['Manikaran', 'Pulga', 'Barshaini'], landmarks: ['Near Manikaran Gurudwara', 'Near the hot springs'] },
  { place: 'Tosh', district: 'Kullu', tehsil: 'Bhuntar', lat: 32.0366, lng: 77.4467, pin: '175105', tier: 2, vibe: ['village', 'trek', 'meadow', 'remote'], localities: ['Tosh', 'Pulga'], landmarks: ['Near Tosh village trail', 'Near the waterfall path'] },
  { place: 'Jibhi', district: 'Kullu', tehsil: 'Banjar', lat: 31.5973, lng: 77.3563, pin: '175123', tier: 2, vibe: ['forest', 'waterfall', 'village', 'remote', 'orchards'], localities: ['Jibhi', 'Jalori Road', 'Shoja', 'Chehni'], landmarks: ['Near Jibhi waterfall', 'Near Jalori Pass road', 'Near Chehni Kothi'] },
  { place: 'Tirthan Valley', district: 'Kullu', tehsil: 'Banjar', lat: 31.6350, lng: 77.4430, pin: '175123', tier: 2, vibe: ['river', 'trout', 'forest', 'remote', 'trek'], localities: ['Gushaini', 'Nagini', 'Sai Ropa', 'Bandal'], landmarks: ['Near Tirthan river', 'Near Great Himalayan National Park gate'] },
  { place: 'Shimla', district: 'Shimla', tehsil: 'Shimla Urban', lat: 31.1048, lng: 77.1734, pin: '171001', tier: 1, vibe: ['colonial', 'deodar', 'town', 'views'], localities: ['Chotta Shimla', 'Sanjauli', 'Summer Hill', 'Mashobra Road', 'Lakkar Bazaar', 'Kaithu'], landmarks: ['Near The Ridge', 'Near Mall Road', 'Near Jakhu Temple', 'Near Christ Church'] },
  { place: 'Kufri', district: 'Shimla', tehsil: 'Shimla Rural', lat: 31.0986, lng: 77.2677, pin: '171012', tier: 2, vibe: ['snow', 'deodar', 'meadow', 'views'], localities: ['Kufri', 'Fagu', 'Mehli'], landmarks: ['Near Himalayan Nature Park', 'Near Fagu viewpoint'] },
  { place: 'Mashobra', district: 'Shimla', tehsil: 'Shimla Rural', lat: 31.0795, lng: 77.2290, pin: '171007', tier: 2, vibe: ['deodar', 'orchards', 'quiet', 'forest'], localities: ['Mashobra', 'Naldehra Road', 'Basantpur'], landmarks: ['Near Sipur Valley', 'Near Reserve Forest Sanctuary'] },
  { place: 'Narkanda', district: 'Shimla', tehsil: 'Kumarsain', lat: 31.2610, lng: 77.4540, pin: '171207', tier: 2, vibe: ['orchards', 'snow', 'meadow', 'views', 'ski'], localities: ['Narkanda', 'Hatu Road', 'Thanedar'], landmarks: ['Near Hatu Peak road', 'Near Tanni Jubbar lake'] },
  { place: 'Theog', district: 'Shimla', tehsil: 'Theog', lat: 31.1180, lng: 77.3510, pin: '171201', tier: 3, vibe: ['orchards', 'village', 'quiet', 'views'], localities: ['Theog', 'Matiana', 'Kotkhai Road'], landmarks: ['Near Theog bazaar', 'Near apple orchard belt'] },
  { place: 'Sarahan', district: 'Shimla', tehsil: 'Sarahan', lat: 31.5110, lng: 77.7960, pin: '172104', tier: 3, vibe: ['temple', 'orchards', 'views', 'remote'], localities: ['Sarahan', 'Jeori'], landmarks: ['Near Bhimakali Temple', 'Near Srikhand Mahadev view'] },
  { place: 'Chail', district: 'Solan', tehsil: 'Kandaghat', lat: 30.9667, lng: 77.2000, pin: '173217', tier: 2, vibe: ['deodar', 'palace', 'forest', 'quiet'], localities: ['Chail', 'Sadhupul', 'Kandaghat Road'], landmarks: ['Near Chail Palace', 'Near the cricket ground'] },
  { place: 'Kasauli', district: 'Solan', tehsil: 'Kasauli', lat: 30.8970, lng: 76.9650, pin: '173204', tier: 2, vibe: ['colonial', 'pine', 'quiet', 'views'], localities: ['Kasauli', 'Garkhal', 'Sanawar Road'], landmarks: ['Near Monkey Point', 'Near Mall Road', 'Near Christ Church'] },
  { place: 'Solan', district: 'Solan', tehsil: 'Solan', lat: 30.9045, lng: 77.0967, pin: '173212', tier: 3, vibe: ['town', 'hills'], localities: ['Solan', 'Shamti', 'Sapron'], landmarks: ['Near Shoolini Temple', 'Near Mall Road'] },
  { place: 'Dharamshala', district: 'Kangra', tehsil: 'Dharamshala', lat: 32.2190, lng: 76.3234, pin: '176215', tier: 1, vibe: ['dhauladhar', 'tea', 'cricket', 'views'], localities: ['Sidhbari', 'Kotwali Bazaar', 'Dari', 'Naddi', 'Khaniyara', 'Sheela Chowk'], landmarks: ['Near HPCA Stadium', 'Near Dal Lake', 'Near War Memorial'] },
  { place: 'McLeodganj', district: 'Kangra', tehsil: 'Dharamshala', lat: 32.2426, lng: 76.3213, pin: '176219', tier: 1, vibe: ['monastery', 'dhauladhar', 'cafes', 'trek'], localities: ['McLeodganj', 'Bhagsu', 'Dharamkot', 'Naddi'], landmarks: ['Near the Dalai Lama Temple', 'Near Bhagsu waterfall', 'Near Triund trailhead'] },
  { place: 'Palampur', district: 'Kangra', tehsil: 'Palampur', lat: 32.1122, lng: 76.5362, pin: '176061', tier: 2, vibe: ['tea', 'dhauladhar', 'quiet', 'views'], localities: ['Palampur', 'Saloh', 'Bundla', 'Chamunda Road'], landmarks: ['Near the tea gardens', 'Near Neugal Khad', 'Near Tashi Jong'] },
  { place: 'Bir', district: 'Kangra', tehsil: 'Baijnath', lat: 32.0463, lng: 76.7185, pin: '176077', tier: 2, vibe: ['paragliding', 'monastery', 'tea', 'cafes', 'views'], localities: ['Bir', 'Billing Road', 'Chaugan', 'Sansal'], landmarks: ['Near Chokling Monastery', 'Near the paragliding landing site', 'Near Billing road'] },
  { place: 'Baijnath', district: 'Kangra', tehsil: 'Baijnath', lat: 32.0524, lng: 76.6487, pin: '176125', tier: 3, vibe: ['temple', 'village', 'tea'], localities: ['Baijnath', 'Paprola', 'Sansal'], landmarks: ['Near Baijnath Temple', 'Near Paprola station'] },
  { place: 'Dalhousie', district: 'Chamba', tehsil: 'Dalhousie', lat: 32.5373, lng: 75.9710, pin: '176304', tier: 1, vibe: ['colonial', 'deodar', 'views', 'quiet'], localities: ['Gandhi Chowk', 'Subhash Baoli', 'Bakrota', 'Banikhet'], landmarks: ['Near Gandhi Chowk', 'Near Subhash Baoli', 'Near the Dalhousie Mall'] },
  { place: 'Khajjiar', district: 'Chamba', tehsil: 'Dalhousie', lat: 32.5524, lng: 76.0612, pin: '176303', tier: 2, vibe: ['meadow', 'lake', 'deodar', 'quiet'], localities: ['Khajjiar', 'Lakkarmandi'], landmarks: ['Near Khajjiar lake', 'Near Khajji Nag Temple'] },
  { place: 'Chamba', district: 'Chamba', tehsil: 'Chamba', lat: 32.5534, lng: 76.1258, pin: '176310', tier: 3, vibe: ['temple', 'river', 'heritage', 'town'], localities: ['Chaugan', 'Sultanpur', 'Rang Mahal'], landmarks: ['Near Lakshmi Narayan Temple', 'Near the Ravi river'] },
  { place: 'Sangla', district: 'Kinnaur', tehsil: 'Sangla', lat: 31.4231, lng: 78.2608, pin: '172106', tier: 2, vibe: ['orchards', 'river', 'snow', 'remote', 'views'], localities: ['Sangla', 'Batseri', 'Rakchham'], landmarks: ['Near Kamru Fort', 'Near Baspa river', 'Near Batseri village'] },
  { place: 'Chitkul', district: 'Kinnaur', tehsil: 'Sangla', lat: 31.3523, lng: 78.4370, pin: '172106', tier: 2, vibe: ['remote', 'river', 'snow', 'village', 'views'], localities: ['Chitkul', 'Rakchham'], landmarks: ['Near the last village road', 'Near Mathi Temple'] },
  { place: 'Kalpa', district: 'Kinnaur', tehsil: 'Kalpa', lat: 31.5399, lng: 78.2578, pin: '172108', tier: 2, vibe: ['apples', 'kailash', 'monastery', 'views', 'remote'], localities: ['Kalpa', 'Roghi', 'Reckong Peo Road'], landmarks: ['Near Kinner Kailash view', 'Near Roghi village'] },
  { place: 'Kaza', district: 'Lahaul and Spiti', tehsil: 'Kaza', lat: 32.2250, lng: 78.0708, pin: '172114', tier: 2, vibe: ['desert', 'monastery', 'remote', 'stars', 'views'], localities: ['Kaza', 'Kibber Road', 'Langza Road'], landmarks: ['Near Key Monastery road', 'Near Kaza market', 'Near Spiti river'] },
  { place: 'Keylong', district: 'Lahaul and Spiti', tehsil: 'Lahaul', lat: 32.5700, lng: 77.0333, pin: '175132', tier: 3, vibe: ['desert', 'river', 'remote', 'views'], localities: ['Keylong', 'Jispa Road', 'Tandi'], landmarks: ['Near Kardang Monastery road', 'Near Bhaga river'] },
  { place: 'Mandi', district: 'Mandi', tehsil: 'Mandi Sadar', lat: 31.7087, lng: 76.9320, pin: '175001', tier: 3, vibe: ['river', 'temple', 'town', 'heritage'], localities: ['Paddal', 'Indira Market', 'Bhiuli', 'Dehra Road'], landmarks: ['Near Panchvaktra Temple', 'Near Beas river', 'Near Victoria Bridge'] },
  { place: 'Rewalsar', district: 'Mandi', tehsil: 'Rewalsar', lat: 31.6309, lng: 76.8325, pin: '175023', tier: 3, vibe: ['lake', 'monastery', 'quiet', 'village'], localities: ['Rewalsar', 'Kunhu', 'Naina Devi Road'], landmarks: ['Near Rewalsar Lake', 'Near the Guru Padmasambhava statue'] },
  { place: 'Barot', district: 'Mandi', tehsil: 'Chhatri', lat: 32.0020, lng: 76.8600, pin: '175021', tier: 3, vibe: ['trout', 'river', 'forest', 'remote', 'quiet'], localities: ['Barot', 'Jhatingri', 'Chhatri'], landmarks: ['Near Uhl river', 'Near the Shanan power house road'] },
  { place: 'Nahan', district: 'Sirmaur', tehsil: 'Nahan', lat: 30.5595, lng: 77.2955, pin: '173001', tier: 3, vibe: ['town', 'heritage', 'lake', 'hills'], localities: ['Nahan', 'Ranital', 'Kala Amb Road'], landmarks: ['Near Rani Tal', 'Near Jagannath Temple', 'Near Nahan market'] },
  { place: 'Renuka Ji', district: 'Sirmaur', tehsil: 'Renukaji', lat: 30.6083, lng: 77.4519, pin: '173022', tier: 3, vibe: ['lake', 'temple', 'quiet', 'village'], localities: ['Renuka', 'Dadahu Road'], landmarks: ['Near Renuka Lake', 'Near the lion safari'] },
  { place: 'Paonta Sahib', district: 'Sirmaur', tehsil: 'Paonta Sahib', lat: 30.4356, lng: 77.6256, pin: '173025', tier: 3, vibe: ['river', 'gurudwara', 'town'], localities: ['Paonta Sahib', 'Poanta Bazaar'], landmarks: ['Near Gurudwara Paonta Sahib', 'Near the Yamuna'] },
  { place: 'Una', district: 'Una', tehsil: 'Una', lat: 31.4685, lng: 76.2708, pin: '174303', tier: 3, vibe: ['plains', 'town', 'temple'], localities: ['Una', 'Santokhgarh', 'Gagret'], landmarks: ['Near Una bus stand', 'Near Chintpurni road'] },
  { place: 'Hamirpur', district: 'Hamirpur', tehsil: 'Hamirpur', lat: 31.6862, lng: 76.5213, pin: '177001', tier: 3, vibe: ['town', 'hills', 'quiet'], localities: ['Hamirpur', 'Nadaun', 'Bhoranj'], landmarks: ['Near Hamirpur bus stand', 'Near the Beas at Nadaun'] },
  { place: 'Bilaspur', district: 'Bilaspur', tehsil: 'Bilaspur', lat: 31.3393, lng: 76.7609, pin: '174001', tier: 3, vibe: ['lake', 'temple', 'views'], localities: ['Bilaspur', 'Ghumarwin', 'Kandrour'], landmarks: ['Near Govind Sagar lake', 'Near Kandrour bridge'] },
  { place: 'Naina Devi', district: 'Bilaspur', tehsil: 'Shri Naina Devi', lat: 31.3050, lng: 76.5360, pin: '174310', tier: 3, vibe: ['temple', 'lake', 'views'], localities: ['Naina Devi', 'Kehloor'], landmarks: ['Near Naina Devi Temple', 'Near Govind Sagar'] },
];

const hp = require(path.join(here, '..', 'dist', 'listings', 'hp-locations.js'));
for (const p of PLACES) {
  if (!hp.isTehsilOf(p.district, p.tehsil)) throw new Error(`invalid tehsil: ${p.place} -> ${p.district}/${p.tehsil}`);
  if (!hp.isInsideHimachal(p.lat, p.lng)) throw new Error(`pin outside Himachal: ${p.place}`);
}

// ───────────────────────────── users plan ─────────────────────────────
// 500 by default: 46% fully verified hosts, 20% verified guests, 4% KYC-verified hosts without a
// payout account, 30% not (fully) verified in assorted states.
const share = (p) => Math.round(USER_COUNT * p);
const PLAN = [
  ['verified_host', share(0.46)],
  ['verified_guest', share(0.2)],
  ['kyc_host_no_bank', share(0.04)],
  ['no_verification', share(0.12)],
  ['identity_pending', share(0.05)],
  ['identity_verified_no_selfie', share(0.05)],
  ['selfie_pending', share(0.03)],
  ['identity_rejected', share(0.04)],
  ['selfie_rejected', share(0.01)],
];
{
  const sum = PLAN.reduce((s, p) => s + p[1], 0);
  PLAN[0][1] += USER_COUNT - sum; // rounding drift goes to verified hosts
}
const HOSTISH = new Set(['verified_host', 'kyc_host_no_bank']);
const REJECT_IDENTITY = [
  'The photo is blurry. Retake it in good light with the whole card in frame.',
  'The name on your ID does not match the name on your profile.',
  'Part of the card is covered or cut off. Show all four corners.',
  'This looks like a photo of a screen, not the card itself.',
];
const REJECT_SELFIE = [
  'We could not confirm a live selfie. Retake it in good light, facing the camera.',
  'Your selfie does not match the photo on your ID.',
  'Only one person should be in the photo.',
];
const BANKS = [
  ['SBIN', 'State Bank of India', 'oksbi'],
  ['HDFC', 'HDFC Bank', 'okhdfcbank'],
  ['ICIC', 'ICICI Bank', 'okicici'],
  ['UTIB', 'Axis Bank', 'okaxis'],
  ['PUNB', 'Punjab National Bank', 'ybl'],
  ['BARB', 'Bank of Baroda', 'ybl'],
  ['CNRB', 'Canara Bank', 'ybl'],
  ['KKBK', 'Kotak Mahindra Bank', 'ybl'],
  ['HPSC', 'Himachal Pradesh State Co-operative Bank', 'ybl'],
  ['UBIN', 'Union Bank of India', 'ybl'],
];
const LANGS_IN = [['English', 'हिन्दी'], ['English', 'हिन्दी', 'Pahari'], ['हिन्दी', 'Pahari'], ['English', 'हिन्दी', 'Punjabi'], ['English', 'Punjabi'], ['English']];
const LANGS_US = [['English'], ['English'], ['English', 'हिन्दी']];

const NOW = Date.now();
const DAY = 86400000;
const phones = new Set();
function uniquePhone() {
  // +91 5xxxxxxxxx — Indian mobile numbers start 6–9, so this range is unassigned and cannot reach anyone.
  for (;;) {
    const p = `+915${String(int(0, 999999999)).padStart(9, '0')}`;
    if (!phones.has(p)) {
      phones.add(p);
      return p;
    }
  }
}
const emails = new Set();
function uniqueEmail(first, last) {
  const f = first.toLowerCase().replace(/[^a-z]/g, '');
  const l = last.toLowerCase().replace(/[^a-z]/g, '');
  for (let k = 0; k < 50; k++) {
    const styles = [`${f}.${l}`, `${f}${l}`, `${f}_${l}`, `${f[0]}${l}`, `${f}.${l}${int(1, 99)}`, `${f}${int(70, 99)}`];
    const local = k < 3 ? styles[k % styles.length] : pick(styles);
    const email = `${local}@${pick(EMAIL_DOMAINS)}`;
    if (!emails.has(email)) {
      emails.add(email);
      return email;
    }
  }
  const email = `${f}.${l}.${emails.size}@${pick(EMAIL_DOMAINS)}`;
  emails.add(email);
  return email;
}
const ts = (ms) => new Date(ms);

const users = [];
const verifications = [];
let order = 0;
for (const [kind, n] of PLAN) {
  for (let i = 0; i < n; i++) {
    const origin = chance(0.64) ? 'in' : 'us';
    const gender = chance(0.5) ? 'm' : 'f';
    const name = drawName(origin, gender);
    const createdMs = NOW - int(20, 220) * DAY - int(0, 86400) * 1000;
    const isHost = HOSTISH.has(kind) || (!['verified_guest'].includes(kind) && chance(0.22));
    const u = {
      id: randomUUID(),
      kind,
      origin,
      ...name,
      email: uniqueEmail(name.first, name.last),
      phone: uniquePhone(),
      languages: origin === 'in' ? pick(LANGS_IN) : pick(LANGS_US),
      isHost,
      createdMs,
      locale: origin === 'in' && chance(0.3) ? 'hi' : 'en',
      selfie_uploaded_at: null,
      bank_verified_at: null,
      bank_upi: null,
      bank_account_name: null,
      order: order++,
    };
    const reviewed = (base, lo, hi) => ts(base + int(lo, hi) * 3600 * 1000);
    const vrow = (type, status, submittedMs, extra = {}) => {
      const reviewedAt = status === 'pending' ? null : reviewed(submittedMs, 1, 48);
      verifications.push({
        id: randomUUID(),
        user_id: u.id,
        verification_type: type,
        document_subtype: type === 'identity' ? 'aadhaar' : null,
        status,
        analysis_result: { source: 'seed', tag: SEED_TAG },
        reviewed_at: reviewedAt,
        submitted_at: ts(submittedMs),
        updated_at: reviewedAt ?? ts(submittedMs),
        rejection_reason: null,
        bank_account_number: null,
        bank_ifsc: null,
        bank_account_holder_name: null,
        bank_name: null,
        ...extra,
      });
      return reviewedAt;
    };
    const idMs = createdMs + int(1, 20) * 3600 * 1000;
    const selfieMs = idMs + int(1, 12) * 3600 * 1000;
    const verifyKyc = () => {
      vrow('identity', 'verified', idMs);
      const r = vrow('selfie', 'verified', selfieMs);
      u.selfie_uploaded_at = r;
    };
    switch (kind) {
      case 'verified_host': {
        verifyKyc();
        const [code, bankName, handle] = pick(BANKS);
        const ifsc = `${code}0${String(int(0, 999999)).padStart(6, '0')}`;
        const bankMs = selfieMs + int(2, 30) * 3600 * 1000;
        const r = vrow('bank', 'verified', bankMs, {
          bank_account_number: String(int(10 ** 10, 10 ** 11 + 9 * 10 ** 10)) + String(int(100, 99999)),
          bank_ifsc: ifsc,
          bank_account_holder_name: u.full,
          bank_name: bankName,
        });
        u.bank_verified_at = r;
        u.bank_account_name = u.full;
        u.bank_upi = `${u.first.toLowerCase().replace(/[^a-z]/g, '')}${int(10, 9999)}@${handle}`;
        u.isHost = true;
        break;
      }
      case 'verified_guest':
        verifyKyc();
        u.isHost = false;
        break;
      case 'kyc_host_no_bank':
        verifyKyc();
        u.isHost = true;
        break;
      case 'identity_pending':
        vrow('identity', 'pending', idMs);
        break;
      case 'identity_verified_no_selfie':
        vrow('identity', 'verified', idMs);
        break;
      case 'selfie_pending':
        vrow('identity', 'verified', idMs);
        vrow('selfie', 'pending', selfieMs);
        break;
      case 'identity_rejected':
        vrow('identity', 'rejected', idMs, { rejection_reason: pick(REJECT_IDENTITY) });
        break;
      case 'selfie_rejected':
        vrow('identity', 'verified', idMs);
        vrow('selfie', 'rejected', selfieMs, { rejection_reason: pick(REJECT_SELFIE) });
        break;
      default:
        break; // no_verification: nothing submitted
    }
    users.push(u);
  }
}
const owners = users.filter((u) => u.kind === 'verified_host');

// ───────────────────────────── listings ─────────────────────────────
const TYPE_META = {
  house: { w: 22, phrase: ['independent house', 'family home', 'whole house', 'hill house'], factor: 1.1 },
  cabin: { w: 14, phrase: ['wooden cabin', 'log cabin', 'timber cabin', 'cedar cabin'], factor: 1.25 },
  flat: { w: 12, phrase: ['apartment', 'self-contained flat', 'serviced apartment', 'homely flat'], factor: 0.9 },
  guestHouse: { w: 12, phrase: ['guesthouse', 'family-run guesthouse', 'private guest suite'], factor: 0.85 },
  farm: { w: 8, phrase: ['farmstay', 'orchard farmhouse', 'working-farm stay'], factor: 1.0 },
  bnb: { w: 6, phrase: ['bed and breakfast', 'homestay with breakfast', 'B&B'], factor: 0.8 },
  tinyHome: { w: 5, phrase: ['tiny home', 'compact micro-cottage', 'tiny wooden home'], factor: 1.05 },
  tent: { w: 5, phrase: ['luxury tent', 'riverside camp tent', 'safari-style tent'], factor: 0.5 },
  treeHouse: { w: 3, phrase: ['treehouse', 'elevated tree cabin'], factor: 1.5 },
  shepherdsHut: { w: 3, phrase: ["shepherd's hut", 'hillside hut'], factor: 1.0 },
  barn: { w: 3, phrase: ['converted barn', 'restored cattle-shed home'], factor: 1.1 },
  earthHome: { w: 3, phrase: ['earth-built home', 'mud-and-stone home', 'traditional pahari home'], factor: 1.15 },
  dome: { w: 2, phrase: ['geodesic dome', 'glass-roof dome'], factor: 1.6 },
  container: { w: 2, phrase: ['container stay', 'converted container home'], factor: 0.8 },
};
const TYPES = Object.entries(TYPE_META);

const AMENITIES_ALL = ['Wifi', 'Workspace', 'Power backup', 'Ceiling fan', 'Iron', 'Kitchen', 'Dining table', 'Refrigerator', 'Microwave', 'Electric kettle', 'Cooking basics', 'Dishes and cutlery', 'Hot water', 'Room heater', 'Attached bathroom', 'Hair dryer', 'Shampoo', 'Washing machine', 'Extra bedding', 'Hangers', 'Blackout curtains', 'Clothes drying rack', 'Mountain views', 'Balcony', 'Valley views', 'Bonfire area', 'Parking', 'Garden', 'Terrace', 'Smoke alarm', 'First aid kit', 'Fire extinguisher', 'TV', 'Streaming services', 'Board games', 'Bluetooth speaker', "Baby's crib", 'High chair'];

const ADJ = ['Deodar', 'Pinewood', 'Cedar', 'Misty', 'Highland', 'Orchard', 'Willow', 'Alpine', 'Sunrise', 'Snowline', 'Riverbend', 'Hillcrest', 'Maple', 'Juniper', 'Rhododendron', 'Whispering', 'Quiet', 'Cloud', 'Blossom', 'Terrace', 'Meadow', 'Stonewall', 'Slate-roof', 'Lantern', 'Fireside', 'Himalayan', 'Pahari', 'Birch', 'Walnut', 'Apple', 'Cherry', 'Pear', 'Thyme', 'Saffron', 'Ember', 'Frostline', 'Dhauladhar', 'Sunset', 'Starlit', 'Moss'];
const NOUN = {
  house: ['House', 'Residence', 'Haveli', 'Lodge', 'Home'],
  cabin: ['Cabin', 'Log House', 'Hideout', 'Retreat'],
  flat: ['Apartment', 'Suites', 'Nest', 'Flat'],
  guestHouse: ['Guesthouse', 'Rooms', 'Stay', 'Lodge'],
  farm: ['Farmstay', 'Orchard', 'Farm', 'Homestead'],
  bnb: ['B&B', 'Homestay', 'Rooms'],
  tinyHome: ['Tiny Home', 'Hut', 'Pod', 'Cottage'],
  tent: ['Camp', 'Tent', 'Glamp'],
  treeHouse: ['Treehouse', 'Canopy', 'Perch'],
  shepherdsHut: ["Shepherd's Hut", 'Hut', 'Bothy'],
  barn: ['Barn', 'Loft', 'Granary'],
  earthHome: ['Earth Home', 'Kothi', 'Stone House'],
  dome: ['Dome', 'Sky Dome', 'Stargazer'],
  container: ['Container Stay', 'Box House', 'Studio'],
};
const STREETS = ['Mall Road', 'Temple Road', 'Orchard Lane', 'Cedar Lane', 'Riverside Path', 'Forest Road', 'Village Road', 'Upper Bazaar Road', 'School Road', 'Ridge Road', 'Panchayat Road', 'Bypass Road', 'Valley Road', 'Lower Colony', 'Hill View Road', 'Market Road'];

const VIBE_LINES = {
  river: ['The river is a short walk away and you fall asleep to it.', 'Water runs close by all year, loud after rain and soft in winter.'],
  snow: ['In winter the slopes around it turn white and the heater earns its keep.', 'Snowfall is common in the cold months, and the road is cleared early.'],
  deodar: ['Old deodar trees stand around the property and keep the mornings cool.', 'It sits among deodars, with birdsong from first light.'],
  cafes: ['Cafes and bakeries are a few minutes away on foot.', 'There is a good run of small cafes nearby when you want a break from cooking.'],
  adventure: ['Rafting, treks and paragliding operators are all within easy reach.', 'Adventure sports start close by, and the host can point you to reliable operators.'],
  castle: ['The old castle and art gallery are close, along a quiet lane.', 'Heritage buildings and a slow village pace surround the stay.'],
  orchards: ['Apple and plum orchards run along the slope below the house.', 'Orchards all around; in season you can pick fruit from the trees.'],
  art: ['A small art and craft scene runs through the neighbourhood.', 'Local weavers and painters work within walking distance.'],
  town: ['The town market, buses and shops are close, which suits a longer stay.', 'Everyday errands are easy: groceries, pharmacy and transport are nearby.'],
  temple: ['A well-known temple is close enough to hear the evening bells.', 'The temple lane is a quiet morning walk away.'],
  valley: ['Wide valley views open up from the front of the house.', 'The valley below is the main show, especially at dawn.'],
  village: ['It sits in a working village, where days start early and nothing is rushed.', 'Village life carries on around you: cattle, kitchen gardens and neighbours who wave.'],
  hotsprings: ['Natural hot springs are within walking distance.', 'The hot springs nearby are good after a day outdoors.'],
  trek: ['Trailheads for several day treks start close to the door.', 'Walking trails go up into the forest from the end of the lane.'],
  meadow: ['Open meadows lie just above the property.', 'A grassy meadow behind the house is good for slow mornings.'],
  remote: ['It is properly remote: very little traffic, dark skies, and a signal that comes and goes.', 'Far from the crowd, so plan your supplies; the quiet is the reason to come.'],
  forest: ['Forest begins at the back fence.', 'The surrounding forest is full of birds and the occasional langur.'],
  waterfall: ['A waterfall walk starts nearby.', 'There is a small waterfall within a short walk.'],
  trout: ['Trout streams run nearby, and fishing is possible with a permit.', 'The stream here is known for trout.'],
  colonial: ['Colonial-era buildings and churches line the walks around it.', 'The neighbourhood has the old-hill-station feel: stone steps, tin roofs and tea shops.'],
  views: ['The views change every hour with the light and the cloud.', 'Open views from the windows and the sit-out.'],
  quiet: ['Quiet lane, no through traffic.', 'A calm spot; evenings are very still.'],
  dhauladhar: ['The Dhauladhar range fills the horizon on clear days.', 'Snow peaks of the Dhauladhars are visible from the property.'],
  tea: ['Tea gardens surround the area, green most of the year.', 'Walks through tea estates start nearby.'],
  cricket: ['The famous cricket ground is a short drive away.', 'Match days bring a buzz to the town.'],
  monastery: ['A Tibetan monastery is close, with morning prayers audible on a still day.', 'Monasteries, prayer flags and momo stalls are all close.'],
  paragliding: ['Paragliding takeoff and landing sites are nearby.', 'Pilots drift overhead on clear afternoons.'],
  palace: ['A heritage palace is a short walk away.', 'Old palace grounds sit at the end of the road.'],
  pine: ['Pine woods surround the area and smell wonderful after rain.', 'It sits in a pine forest with a clean, resinous air.'],
  hills: ['Rolling hills in every direction.', 'Hilly terrain with pleasant walks.'],
  lake: ['A lake is a short stroll away.', 'You can walk to the lake in a few minutes.'],
  heritage: ['Old heritage streets and temples fill the town.', 'The town has deep history; the old quarter is a good wander.'],
  desert: ['High cold-desert landscape: bare ridges, big sky and thin air.', 'Stark mountain-desert scenery surrounds the village.'],
  stars: ['With almost no light pollution, the night sky is spectacular.', 'Stargazing here needs nothing but a blanket.'],
  kailash: ['Kinner Kailash is visible from the window on clear mornings.', 'The Kinner Kailash peak catches the first light.'],
  apples: ['Apple orchards cover the slopes, heavy with fruit in autumn.', 'Orchards and old Kinnauri houses line the village.'],
  ski: ['A small ski slope operates nearby in good winters.', 'Skiing is possible on the slopes above in snow season.'],
  gurudwara: ['A large gurudwara with a langar hall is close by.', 'The gurudwara is a short walk.'],
  plains: ['It sits at the foot of the hills with easy road access.', 'Flat, easy terrain and fast roads in every direction.'],
};
const OPENERS = [
  (c) => `${title(c.article)} ${c.phrase} in ${c.where}, with ${c.bedsText} for up to ${c.maxGuests} guests.`,
  (c) => `This ${c.phrase} in ${c.where} sleeps ${c.maxGuests} across ${c.bedsText}.`,
  (c) => `${c.locality === c.place ? `In the heart of ${c.place}` : `Set in ${c.locality}, close to ${c.place}`}, this ${c.phrase} offers ${c.bedsText} and room for ${c.maxGuests}.`,
  (c) => `A ${c.phrase} you can settle into for a few nights or a whole season, in ${c.where}.`,
  (c) => `${c.title} is a ${c.phrase} in ${c.where}, built for guests who stay longer than a weekend.`,
  (c) => `Welcome to ${c.title}: a ${c.phrase} with ${c.bedsText}, in the hills of ${c.district}.`,
  (c) => `${c.locality === c.place ? 'Right in town' : `From ${c.locality}`}, this ${c.phrase} has ${c.bedsText} and a good base for exploring ${c.place}.`,
];
const HOST_LINES = [
  (c) => `${c.hostFirst} lives close by and answers messages quickly.`,
  (c) => `${c.hostFirst} looks after the place personally and is happy to share local tips.`,
  (c) => `Your host, ${c.hostFirst}, keeps the house stocked and is a call away if anything is needed.`,
  (c) => `${c.hostFirst} and family run it and will meet you on arrival.`,
  (c) => `Hosted by ${c.hostFirst}, who can arrange taxis, groceries and local guides.`,
  (c) => `${c.hostFirst} is usually on hand for a chat, but gives you plenty of privacy.`,
];
const INTERIOR = {
  workspace: ['There is a proper desk with a fast connection, good for remote work.', 'A dedicated workspace and steady wifi make working from here easy.'],
  kitchen: ['The kitchen has what you need to cook real meals, from the basics to a kettle and a fridge.', 'You can cook for yourself: the kitchen is equipped with utensils and a gas stove.'],
  heater: ['Rooms are warm in winter with a room heater and hot water on tap.', 'A heater and plenty of blankets keep the cold out.'],
  balcony: ['A balcony off the main room is where most guests end up with their tea.', 'The sit-out is the best seat in the house.'],
  garden: ['A small garden is yours to use.', 'The garden gets sun most of the day.'],
  basic: ['Simple, clean and comfortable, with everything you actually use.', 'The interior is modest and homely, kept spotless between stays.'],
};
const PRACTICAL = {
  all: 'Electricity and water bills are included in the rate.',
  electricity_extra: 'Electricity is charged extra at actuals; water is included.',
  none: 'Utilities are charged separately at actuals.',
};

// A pool of room templates so "The space" differs between listings.
const SPACE_LINES = [
  (c) => `${c.bedrooms === 0 ? 'One open studio room' : `${c.bedrooms} bedroom${c.bedrooms > 1 ? 's' : ''}`}, ${c.bathrooms} bathroom${c.bathrooms > 1 ? 's' : ''}${c.hasKitchen ? ', a kitchen' : ''} and a sit-out.`,
  (c) => `${c.bedrooms === 0 ? 'A studio layout' : `${c.bedrooms}-bedroom layout`} with ${c.bathrooms} bath${c.bathrooms > 1 ? 's' : ''}; ${c.hasKitchen ? 'the kitchen opens into the living area' : 'meals can be arranged by the host'}.`,
  (c) => `Living area, ${c.bedrooms === 0 ? 'a sleeping nook' : `${c.bedrooms} bedroom${c.bedrooms > 1 ? 's' : ''}`}, ${c.bathrooms} bathroom${c.bathrooms > 1 ? 's' : ''}${c.hasKitchen ? ' and a working kitchen' : ''}.`,
];
const ACCESS_LINES = [
  'Guests have the whole space to themselves, including the sit-out and the front garden.',
  'You have your own entrance and the use of the shared terrace.',
  'The entire unit is yours; the host lives in a separate part of the property.',
  'Private entrance; parking is on the lane outside.',
  'You have full access to the interior and outdoor seating.',
];

const TIER_RANGE = { 1: [1800, 7500], 2: [1400, 6000], 3: [800, 3500] };
const roundTo = (n, step) => Math.round(n / step) * step;

const usedTitles = new Set();
const usedDescriptions = new Set();
const usedPhotoSeeds = new Set();

function makeListing(owner, idxInHost) {
  const place = weighted(PLACES, (p) => (p.tier === 1 ? 3 : p.tier === 2 ? 2.2 : 1));
  const [type] = weighted(TYPES, ([, m]) => m.w);
  const meta = TYPE_META[type];
  const placeType =
    type === 'guestHouse' || type === 'bnb' ? pickWeighted([['room', 55], ['entire', 40], ['sharedRoom', 5]]) :
    ['flat', 'house', 'farm'].includes(type) && chance(0.1) ? 'room' : 'entire';
  const bedroomsRaw = placeType === 'entire' ? pickWeighted([[0, 8], [1, 34], [2, 32], [3, 18], [4, 6], [5, 2]]) : 1;
  const bedrooms = ['tent', 'dome', 'container', 'tinyHome', 'treeHouse', 'shepherdsHut'].includes(type) ? Math.min(bedroomsRaw, 1) : bedroomsRaw;
  const beds = bedrooms === 0 ? 'Studio' : bedrooms === 1 ? '1BHK' : bedrooms === 2 ? '2BHK' : '3BHK';
  const bathrooms = Math.max(1, Math.min(bedrooms === 0 ? 1 : bedrooms, placeType === 'entire' ? int(1, Math.max(1, bedrooms)) : 1));
  const maxGuests = placeType === 'entire' ? Math.max(2, bedrooms * 2 + int(0, 2) - (bedrooms === 0 ? 0 : 0)) : int(1, 3);
  const locality = pick(place.localities);
  const localityField = locality === place.place ? '' : locality; // never "Sangla, Sangla"
  const landmark = chance(0.7) ? pick(place.landmarks) : '';
  const jitter = (v) => v + (rnd() - 0.5) * 2 * 0.012; // ~±1.3 km around the town centre
  let lat = jitter(place.lat);
  let lng = jitter(place.lng);
  if (!hp.isInsideHimachal(lat, lng)) {
    lat = place.lat;
    lng = place.lng;
  }
  lat = Math.round(lat * 1e6) / 1e6;
  lng = Math.round(lng * 1e6) / 1e6;

  // price
  const [lo, hi] = TIER_RANGE[place.tier];
  let rate = (lo + rnd() * (hi - lo) * 0.7) * meta.factor * (1 + 0.32 * Math.max(0, bedrooms - 1)) * (0.85 + rnd() * 0.3);
  if (placeType !== 'entire') rate *= placeType === 'room' ? 0.45 : 0.3;
  rate = Math.max(500, Math.min(100000, roundTo(rate, 50)));
  const weekly = pick([0, 5, 5, 10, 10, 15, 20]);
  const monthly = Math.max(weekly, pick([10, 15, 20, 25, 30, 35, 40, 45]));
  const minDays = pickWeighted([[1, 30], [2, 14], [3, 10], [7, 18], [15, 8], [30, 20]]);

  // amenities themed by vibe/type
  const has = (a, p) => (chance(p) ? [a] : []);
  const outdoorsy = ['tent', 'treeHouse', 'shepherdsHut', 'dome'].includes(type);
  const am = new Set([
    'Hot water',
    ...(type === 'tent' ? [] : ['Attached bathroom']),
    ...has('Wifi', outdoorsy ? 0.4 : 0.88),
    ...has('Power backup', 0.6),
    ...has('Workspace', outdoorsy ? 0.05 : 0.38),
    ...has('Kitchen', outdoorsy ? 0.2 : 0.78),
    ...has('Room heater', place.vibe.includes('snow') || place.tier < 3 ? 0.85 : 0.5),
    ...has('Parking', 0.7),
    ...has('Mountain views', place.vibe.some((v) => ['views', 'dhauladhar', 'kailash', 'snow'].includes(v)) ? 0.8 : 0.3),
    ...has('Valley views', place.vibe.includes('valley') ? 0.8 : 0.25),
    ...has('Balcony', 0.4),
    ...has('Garden', 0.35),
    ...has('Terrace', 0.2),
    ...has('Bonfire area', outdoorsy || place.vibe.includes('remote') ? 0.6 : 0.25),
    ...has('TV', 0.35),
    ...has('Washing machine', 0.3),
    ...has('First aid kit', 0.45),
    ...has('Smoke alarm', 0.4),
  ]);
  for (const a of pickN(AMENITIES_ALL, int(1, 4))) am.add(a);
  while (am.size < 6) am.add(pick(AMENITIES_ALL));
  const amenities = [...am].slice(0, 16);
  const hasKitchen = am.has('Kitchen');
  const hasWork = am.has('Workspace') && am.has('Wifi');
  const hasViews = am.has('Mountain views') || am.has('Valley views') || am.has('Balcony');

  const categories = [];
  if (minDays >= 7) categories.push('long');
  if (placeType === 'entire') categories.push('entire');
  if (hasWork) categories.push('work');
  if (hasViews) categories.push('views');
  if (place.tier === 3 || place.vibe.some((v) => ['quiet', 'remote', 'village', 'meadow', 'forest'].includes(v))) categories.push('quiet');
  if (categories.length === 0) categories.push(placeType === 'entire' ? 'entire' : 'long');

  // title (unique)
  const typeNoun = pick(NOUN[type]);
  const hostPossessive = `${owner.first}'s`;
  let titleText = '';
  for (let t = 0; t < 40; t++) {
    const style = t < 30 ? int(0, 4) : 5;
    const candidate =
      style === 0 ? `${pick(ADJ)} ${typeNoun} in ${locality}` :
      style === 1 ? `${pick(ADJ)} ${typeNoun}, ${place.place}` :
      style === 2 ? `${hostPossessive} ${pick(ADJ)} ${typeNoun}` :
      style === 3 ? `The ${owner.last} ${type === 'house' || type === 'farm' || type === 'earthHome' ? 'Homestay' : typeNoun}, ${locality}` :
      style === 4 ? `${pick(ADJ)} ${pick(ADJ)} ${typeNoun}` :
      `${pick(ADJ)} ${typeNoun} ${locality} ${int(2, 99)}`;
    const trimmed = candidate.length > 60 ? candidate.slice(0, 60).trim() : candidate;
    if (trimmed.length >= 4 && !usedTitles.has(trimmed.toLowerCase())) {
      usedTitles.add(trimmed.toLowerCase());
      titleText = trimmed;
      break;
    }
  }
  if (!titleText) throw new Error('could not make a unique title');

  // description (unique)
  const phrase = pick(meta.phrase);
  const ctx = {
    title: titleText,
    phrase,
    article: /^[aeiou]/i.test(phrase) ? 'an' : 'a',
    place: place.place,
    locality,
    where: locality === place.place ? place.place : `${locality}, ${place.place}`,
    district: place.district,
    bedsText: bedrooms === 0 ? 'an open studio' : `${bedrooms} bedroom${bedrooms > 1 ? 's' : ''}`,
    maxGuests,
    hostFirst: owner.first,
    bedrooms,
    bathrooms,
    hasKitchen,
  };
  let description = '';
  for (let t = 0; t < 30; t++) {
    const vibes = pickN(place.vibe, 2).map((v) => pick(VIBE_LINES[v] || VIBE_LINES.quiet));
    const interior = hasWork && chance(0.5) ? pick(INTERIOR.workspace) : hasKitchen && chance(0.5) ? pick(INTERIOR.kitchen) : am.has('Room heater') && chance(0.5) ? pick(INTERIOR.heater) : am.has('Balcony') && chance(0.5) ? pick(INTERIOR.balcony) : am.has('Garden') && chance(0.4) ? pick(INTERIOR.garden) : pick(INTERIOR.basic);
    const billsKey = pickWeighted([['all', 45], ['electricity_extra', 35], ['none', 20]]);
    ctx.billsKey = billsKey;
    const parts = [pick(OPENERS)(ctx), ...vibes, interior, pick(HOST_LINES)(ctx), PRACTICAL[billsKey]];
    const text = parts.join(' ');
    if (!usedDescriptions.has(text)) {
      usedDescriptions.add(text);
      description = text;
      break;
    }
  }
  if (!description) throw new Error('could not make a unique description');
  const billsIncluded = ctx.billsKey;

  // photos: unique seeds per listing
  const nPhotos = int(5, 8);
  const rooms = ['exterior', 'living', 'bedroom', 'kitchen', 'view', 'bath'];
  const slug = randomUUID().replace(/-/g, '').slice(0, 12);
  usedPhotoSeeds.add(slug);
  const photos = Array.from({ length: nPhotos }, (_, i) => ({
    url: `https://picsum.photos/seed/${slug}-${i + 1}/1200/800`,
    room: rooms[i % rooms.length],
  }));

  const street = `${pick(STREETS)}`;
  const flat = chance(0.55) ? `${pick(['House No. ', 'Flat ', 'Plot ', 'Unit '])}${int(1, 180)}` : '';
  const checkIn = pick(['12:00 pm – 9:00 pm', '2:00 pm – 10:00 pm', '1:00 pm – 8:00 pm', 'After 11:00 am, flexible']);
  const checkOut = pick(['Before 11:00 am', 'Before 10:00 am', 'Before 12:00 pm']);
  const created = Math.min(NOW - DAY, owner.createdMs + int(5, 120) * DAY + int(0, 86400) * 1000);
  const availableFrom = new Date(NOW + int(0, 60) * DAY).toISOString().slice(0, 10);
  const status = chance(0.94) ? 'live' : 'in_review';

  const fullAddress = [flat, street, landmark, localityField, place.place, 'Himachal Pradesh', place.pin].filter(Boolean).join(', ');
  const property_details = {
    title: titleText,
    propertyType: type,
    placeType,
    beds,
    bedrooms,
    bathrooms,
    maxGuests,
    district: place.district,
    tehsil: place.tehsil,
    town: place.tehsil,
    flatNumber: flat,
    streetAddress: street,
    landmark,
    locality: localityField,
    city: place.place,
    state: 'Himachal Pradesh',
    pincode: place.pin,
    fullAddress,
    lat,
    lng,
    description,
    theSpace: pick(SPACE_LINES)(ctx),
    guestAccess: pick(ACCESS_LINES),
    photos,
    dailyBaseRate: rate,
    weeklyDiscountPct: weekly,
    monthlyDiscountPct: monthly,
    minDays,
    availableFrom,
    billsIncluded,
    checkIn,
    checkOut,
    pets: chance(0.28),
    smoking: chance(0.1),
    cancellation: pickWeighted([['flexible', 30], ['moderate', 45], ['firm', 25]]),
    categories,
    amenities,
  };
  return {
    id: randomUUID(),
    host_id: owner.id,
    status,
    created_at: new Date(created),
    draft_data: { seedTag: SEED_TAG, property_details, telemetry: { walkthroughPassed: true }, banking: {}, media: {} },
  };
}

// listings per host: 1–4, scaled to hit the target
const counts = owners.map(() => pickWeighted([[1, 38], [2, 34], [3, 20], [4, 8]]));
let total = counts.reduce((a, b) => a + b, 0);
for (let guard = 0; total !== LISTING_TARGET && guard < 20000; guard++) {
  const i = int(0, counts.length - 1);
  if (total < LISTING_TARGET && counts[i] < 4) {
    counts[i]++;
    total++;
  } else if (total > LISTING_TARGET && counts[i] > 1) {
    counts[i]--;
    total--;
  }
}
const listings = [];
owners.forEach((o, i) => {
  for (let k = 0; k < counts[i]; k++) listings.push(makeListing(o, k));
});

// ───────────────────────────── report + checks ─────────────────────────────
const by = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});
const dup = (arr) => arr.length - new Set(arr).size;
console.log(`Users: ${users.length}  | by state: ${JSON.stringify(by(users, (u) => u.kind))}`);
console.log(`  origin: ${JSON.stringify(by(users, (u) => u.origin))}  | hosts flagged: ${users.filter((u) => u.isHost).length}`);
console.log(`  duplicate full names: ${dup(users.map((u) => u.full.toLowerCase()))}, first names: ${dup(users.map((u) => u.first.toLowerCase()))}, emails: ${dup(users.map((u) => u.email))}, phones: ${dup(users.map((u) => u.phone))}`);
console.log(`  most-used surnames: ${[...surnameUses].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, c]) => `${s}×${c}`).join(', ')}`);
console.log(`Verification rows: ${verifications.length}  | ${JSON.stringify(by(verifications, (v) => `${v.verification_type}:${v.status}`))}`);
console.log(`Listings: ${listings.length} across ${owners.length} fully verified hosts | status ${JSON.stringify(by(listings, (l) => l.status))}`);
console.log(`  duplicate titles: ${dup(listings.map((l) => l.draft_data.property_details.title.toLowerCase()))}, descriptions: ${dup(listings.map((l) => l.draft_data.property_details.description))}`);
console.log(`  districts: ${JSON.stringify(by(listings, (l) => l.draft_data.property_details.district))}`);
console.log(`  types: ${JSON.stringify(by(listings, (l) => l.draft_data.property_details.propertyType))}`);
const rates = listings.map((l) => l.draft_data.property_details.dailyBaseRate);
console.log(`  daily rate: min ${Math.min(...rates)}, median ${rates.sort((a, b) => a - b)[Math.floor(rates.length / 2)]}, max ${Math.max(...rates)}`);
console.log('Sample users:', users.slice(0, 3).concat(users.slice(-2)).map((u) => `${u.full} <${u.email}> ${u.kind}`));
console.log('Sample titles:', listings.slice(0, 5).map((l) => l.draft_data.property_details.title));

if (flag('show')) {
  console.log('\nNames:', users.slice(0, 60).map((u) => `${u.full} (${u.origin})`).join('; '));
  for (const l of listings.slice(0, 4)) {
    const d = l.draft_data.property_details;
    console.log(`\n— ${d.title} | ${d.propertyType}/${d.placeType} ${d.beds} ${d.bedrooms}br ${d.bathrooms}ba x${d.maxGuests} | ${d.town}, ${d.district} ${d.pincode} | Rs ${d.dailyBaseRate}/night min ${d.minDays}d`);
    console.log(`  ${d.fullAddress}`);
    console.log(`  ${d.description}`);
    console.log(`  space: ${d.theSpace} | access: ${d.guestAccess}`);
    console.log(`  categories ${d.categories.join(',')} | amenities ${d.amenities.join(', ')} | ${d.photos.length} photos`);
  }
}
if (DRY) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

// ───────────────────────────── write ─────────────────────────────
function multiInsert(table, columns, rows, casts = {}) {
  const values = [];
  const tuples = rows.map((row) => {
    const start = values.length;
    values.push(...row);
    return `(${row.map((_, k) => `$${start + k + 1}${casts[columns[k]] || ''}`).join(',')})`;
  });
  return { text: `insert into ${table} (${columns.join(',')}) values ${tuples.join(',')}`, values };
}
const c = await connect();
const existing = (await c.query(`select count(*)::int n from users where email ~ '@example\\.(com|org|net)$'`)).rows[0].n;
if (existing > 0) {
  console.error(`Refusing to seed: ${existing} example.* users already exist. Run with --clean --yes first.`);
  await c.end();
  process.exit(1);
}
await c.query('begin');
try {
  const BATCH = 100;
  for (let i = 0; i < users.length; i += BATCH) {
    const rows = users.slice(i, i + BATCH).map((u) => [u.id, u.full, u.email, u.phone, u.languages, u.isHost, u.isHost ? 'individual' : null, u.locale, ts(u.createdMs), u.selfie_uploaded_at, u.bank_upi, u.bank_account_name, u.bank_verified_at]);
    const q = multiInsert('users', ['id', 'full_name', 'email', 'phone', 'languages', '"isHost"', 'host_kind', 'preferred_locale', 'created_at', 'selfie_uploaded_at', 'bank_upi', 'bank_account_name', 'bank_verified_at'], rows);
    await c.query(q.text, q.values);
  }
  for (let i = 0; i < verifications.length; i += BATCH) {
    const rows = verifications.slice(i, i + BATCH).map((v) => [v.id, v.user_id, v.verification_type, v.document_subtype, v.status, v.bank_account_number, v.bank_ifsc, v.bank_account_holder_name, v.bank_name, JSON.stringify(v.analysis_result), v.rejection_reason, v.reviewed_at, v.submitted_at, v.updated_at]);
    const q = multiInsert('verification_requests', ['id', 'user_id', 'verification_type', 'document_subtype', 'status', 'bank_account_number', 'bank_ifsc', 'bank_account_holder_name', 'bank_name', 'analysis_result', 'rejection_reason', 'reviewed_at', 'submitted_at', 'updated_at'], rows, { analysis_result: '::jsonb' });
    await c.query(q.text, q.values);
  }
  for (let i = 0; i < listings.length; i += BATCH) {
    const rows = listings.slice(i, i + BATCH).map((l) => [l.id, l.host_id, l.status, JSON.stringify(l.draft_data), l.created_at, l.created_at, 'en']);
    const q = multiInsert('listings', ['id', 'host_id', 'status', 'draft_data', 'created_at', 'updated_at', 'source_locale'], rows, { draft_data: '::jsonb' });
    await c.query(q.text, q.values);
  }
  await c.query('commit');
  console.log(`\nSeeded ${users.length} users, ${verifications.length} verification rows, ${listings.length} listings.`);
} catch (e) {
  await c.query('rollback');
  console.error('Rolled back, nothing written:', e.message);
  process.exitCode = 1;
}
await c.end();
