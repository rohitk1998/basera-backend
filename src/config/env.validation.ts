import { z } from 'zod';

const envBoolean = z.preprocess((v) => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  const t = String(v).trim().toLowerCase();
  if (t === 'true' || t === '1') return true;
  if (t === 'false' || t === '0') return false;
  return v;
}, z.boolean().default(false));

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
  APP_URL: z.string().default('https://basera.in'),

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
  DIDIT_API_KEY: z.string().optional(),
  DIDIT_WORKFLOW_ID: z.string().optional(),
  DIDIT_WEBHOOK_SECRET: z.string().optional(),
  DIDIT_BASE_URL: z.string().url().optional().or(z.literal('')),
  DIDIT_CALLBACK_URL: z.string().optional(),
  DIDIT_SANDBOX_SCENARIO: z.string().optional(),
  NOMINATIM_BASE_URL: z.string().url().optional().or(z.literal('')),
  NOMINATIM_MIN_GAP_MS: z.coerce.number().int().min(0).optional(),
  GOOGLE_MAPS_SERVER_KEY: z.string().optional(),
  GOOGLE_GEOCODE_BASE_URL: z.string().url().optional().or(z.literal('')),
  YOUTUBE_API_KEY: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  DB_POOL_MAX: z.coerce.number().int().default(10),

  CAPTURE_LOCATION_BYPASS: envBoolean,

  CHECKOUT_DATE_BYPASS: envBoolean,

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
  return env;
}
