#!/usr/bin/env node
// Load test against a REAL, network-reachable backend instance (i.e. one
// actually talking to Supabase) — this only measures something meaningful
// when run from a machine that can reach that Postgres host. Run it from
// your laptop, CI, or a VM, pointed at a running `node dist/main.js` (or a
// deployed instance), not from a sandbox with no DB egress.
//
// Usage:
//   BASE_URL=http://localhost:4000 node scripts/loadtest.mjs
//   BASE_URL=https://staging.basera.in node scripts/loadtest.mjs --connections 100 --duration 20
//
// Targets public, DB-backed, unauthenticated endpoints — no login needed,
// and representative of real traffic (search is the hottest path in the app).
import autocannon from 'autocannon';

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const connections = Number(arg('connections', 50));
const duration = Number(arg('duration', 15));

const targets = [
  { name: 'GET /api/listings (search, no filters)', path: '/api/listings?pageSize=20' },
  { name: 'GET /api/listings (filtered search)', path: '/api/listings?town=Goa&category=stay&pageSize=20' },
  { name: 'GET /api/listings/towns (aggregate)', path: '/api/listings/towns' },
];

function run(target) {
  return new Promise((resolve, reject) => {
    console.log(`\n=== ${target.name} ===`);
    console.log(`${BASE_URL}${target.path}  (${connections} connections, ${duration}s)`);
    const instance = autocannon(
      {
        url: `${BASE_URL}${target.path}`,
        connections,
        duration,
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    autocannon.track(instance, { renderProgressBar: true });
  });
}

const results = [];
for (const target of targets) {
  // Sequential on purpose: each endpoint's number should reflect that
  // endpoint under load, not several endpoints competing for the same
  // 10-connection DB pool at once.
  const result = await run(target);
  results.push({ target: target.name, result });
}

console.log('\n\n================ SUMMARY ================');
for (const { target, result } of results) {
  console.log(`\n${target}`);
  console.log(`  avg req/s:  ${result.requests.average}`);
  console.log(`  p50 latency: ${result.latency.p50}ms`);
  console.log(`  p99 latency: ${result.latency.p99}ms`);
  console.log(`  max latency: ${result.latency.max}ms`);
  console.log(`  2xx: ${result['2xx']}  non-2xx: ${result.non2xx}  errors: ${result.errors}`);
}
