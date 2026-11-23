import { validateEnv } from './env.validation';

const base = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  SUPABASE_JWT_SECRET: 's',
  SUPABASE_DB_HOST: 'h',
  SUPABASE_DB_PASSWORD: 'p',
  FIREBASE_PROJECT_ID: 'f',
  FIREBASE_CLIENT_EMAIL: 'e',
  FIREBASE_PRIVATE_KEY: 'k',
};
const prod = { ...base, NODE_ENV: 'production', CASHFREE_PG_CLIENT_ID: 'a', CASHFREE_PG_CLIENT_SECRET: 'b', ID_HASH_PEPPER: 'p'.repeat(32) };

describe('validateEnv', () => {
  it('applies defaults for TRUST_PROXY, DB_SSL, DB_LOG_QUERIES', () => {
    const env = validateEnv(base);
    expect(env.TRUST_PROXY).toBe('loopback');
    expect(env.DB_SSL).toBe(true);
    expect(env.DB_LOG_QUERIES).toBe(false);
  });

  it('parses DB_SSL=false and TRUST_PROXY hop counts', () => {
    const env = validateEnv({ ...base, DB_SSL: 'false', TRUST_PROXY: '1' });
    expect(env.DB_SSL).toBe(false);
    expect(env.TRUST_PROXY).toBe('1');
  });

  it('rejects a garbage DB_SSL', () => {
    expect(() => validateEnv({ ...base, DB_SSL: 'maybe' })).toThrow();
  });

  it('blocks bypass flags and query logging in production', () => {
    expect(() => validateEnv({ ...prod, CAPTURE_LOCATION_BYPASS: 'true' })).toThrow(/CAPTURE_LOCATION_BYPASS/);
    expect(() => validateEnv({ ...prod, CHECKOUT_DATE_BYPASS: 'true' })).toThrow(/CHECKOUT_DATE_BYPASS/);
    expect(() => validateEnv({ ...prod, DB_LOG_QUERIES: 'true' })).toThrow(/DB_LOG_QUERIES/);
    expect(() => validateEnv(prod)).not.toThrow();
  });

  it('requires ID_HASH_PEPPER (min 32) in production only', () => {
    const { ID_HASH_PEPPER: _omit, ...noPepper } = prod;
    expect(() => validateEnv(noPepper)).toThrow(/ID_HASH_PEPPER/);
    expect(() => validateEnv({ ...prod, ID_HASH_PEPPER: 'short' })).toThrow();
    expect(() => validateEnv(base)).not.toThrow();
  });
});
