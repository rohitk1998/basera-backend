import { z } from 'zod';

const envBoolean = z.preprocess((v) => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  const t = String(v).trim().toLowerCase();
  if (t === 'true' || t === '1') return true;
  if (t === 'false' || t === '0') return false;
  return v;
}, z.boolean().default(false));

// Express 'trust proxy': a hop count ("1"), a boolean, or a preset/subnet/IP list ("loopback", "10.0.0.0/8").
// "true" trusts every hop and lets clients spoof X-Forwarded-For (and dodge rate limits) unless the
// app is only reachable through your proxy; prefer a hop count or subnet.
const trustProxy = z
  .string()
  .trim()
  .min(1)
  .default('loopback')
  .refine((v) => /^(true|false|\d+|[A-Za-z0-9.:/_,\s-]+)$/.test(v), { message: 'TRUST_PROXY is not a valid trust proxy value' });

const envSchema = z.object({
  PORT: z.coerce.number().int().default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1),

  SUPABASE_DB_HOST: z.string().min(1),
  SUPABASE_DB_PORT: z.coerce.number().int().default(5432),
  SUPABASE_DB_NAME: z.string().default('postgres'),
  SUPABASE_DB_USER: z.string().default('postgres'),
  SUPABASE_DB_PASSWORD: z.string().min(1),

  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().min(1),
  FIREBASE_PRIVATE_KEY: z.string().min(1),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  APP_URL: z.string().default('https://www.rhenbasera.online'),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  UNSPLASH_ACCESS_KEY: z.string().optional(),

  SARVAM_API_KEY: z.string().optional(),

  CASHFREE_PG_CLIENT_ID: z.string().optional(),
  CASHFREE_PG_CLIENT_SECRET: z.string().optional(),
  CASHFREE_PG_API_VERSION: z.string().default('2023-08-01'),
  CASHFREE_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  WHATSAPP_DRY_RUN: envBoolean,
  // Optional E.164 number that receives the admin WhatsApp alert for new stay requests.
  ADMIN_WHATSAPP_NUMBER: z.string().regex(/^\+[1-9]\d{7,14}$/, 'ADMIN_WHATSAPP_NUMBER must be E.164, e.g. +919876543210').optional().or(z.literal('')),
  // Host verify-and-purge. The pepper keys the ID-number hash that blocks banned users from
  // re-registering; changing it later orphans every stored hash, so set it once and keep it secret.
  ID_HASH_PEPPER: z.string().min(32).optional(),
  // Optional Python worker (InsightFace/DeepFace) that scores ID portrait vs live frames.
  FACE_MATCH_URL: z.string().url().optional().or(z.literal('')),
  FACE_MATCH_SECRET: z.string().optional(),
  NOMINATIM_BASE_URL: z.string().url().optional().or(z.literal('')),
  NOMINATIM_MIN_GAP_MS: z.coerce.number().int().min(0).optional(),
  GOOGLE_MAPS_SERVER_KEY: z.string().optional(),
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  GOOGLE_PLACES_DRY_RUN: envBoolean,
  GOOGLE_GEOCODE_BASE_URL: z.string().url().optional().or(z.literal('')),
  YOUTUBE_API_KEY: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  TRUST_PROXY: trustProxy,
  // TLS to Postgres. Defaults to on; set DB_SSL=false only for a local, non-TLS database.
  DB_SSL: z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return undefined;
    const t = String(v).trim().toLowerCase();
    if (t === 'true' || t === '1') return true;
    if (t === 'false' || t === '0') return false;
    return v;
  }, z.boolean().default(true)),
  // Log every SQL statement (dev debugging only; parameters can contain PII).
  DB_LOG_QUERIES: envBoolean,
  DB_POOL_MAX: z.coerce.number().int().default(10),

  CAPTURE_LOCATION_BYPASS: envBoolean,

  CHECKOUT_DATE_BYPASS: envBoolean,

  // Admin vetting: external rating below this is flagged (meetsThreshold=false), never blocks approval.
  VETTING_MIN_RATING: z.coerce.number().min(0).max(5).default(4),

  PLATFORM_COMMISSION_PERCENTAGE: z.coerce
    .number()
    .default(6)
    .refine((value) => value >= 5 && value <= 7, {
      message: 'PLATFORM_COMMISSION_PERCENTAGE must be between 5 and 7 inclusive',
    }),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const env = envSchema.parse(config);
  if (env.CAPTURE_LOCATION_BYPASS && config.NODE_ENV === 'production') {
    throw new Error('CAPTURE_LOCATION_BYPASS must never be enabled in production');
  }
  if (env.CHECKOUT_DATE_BYPASS && config.NODE_ENV === 'production') {
    throw new Error('CHECKOUT_DATE_BYPASS must never be enabled in production');
  }
  if (config.NODE_ENV === 'production' && (!env.CASHFREE_PG_CLIENT_ID || !env.CASHFREE_PG_CLIENT_SECRET)) {
    throw new Error('CASHFREE_PG_CLIENT_ID and CASHFREE_PG_CLIENT_SECRET are required in production');
  }
  if (config.NODE_ENV === 'production' && env.DB_LOG_QUERIES) {
    throw new Error('DB_LOG_QUERIES must not be enabled in production');
  }
  if (config.NODE_ENV === 'production' && !env.ID_HASH_PEPPER) {
    throw new Error('ID_HASH_PEPPER (min 32 chars) is required in production');
  }
  return env;
}
