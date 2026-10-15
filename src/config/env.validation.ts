import { z } from 'zod';

/** 'true'/'false'/'1'/'0' (or a real boolean) -> boolean; anything else is an error. */
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

  // Not actually optional — FirebaseAdminProvider's constructor calls
  // cert() unconditionally on every boot, so a missing value here doesn't
  // degrade gracefully, it crashes app startup with an opaque Firebase SDK
  // error. Required so a misconfigured deploy fails fast with a clear zod
  // message instead.
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().min(1),
  FIREBASE_PRIVATE_KEY: z.string().min(1),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  APP_URL: z.string().default('https://basera.in'),

  // Gmail SMTP — used only for the email-OTP send path (see
  // NotificationsService.sendEmailOtpViaSmtp); every other transactional
  // email still goes through Resend above.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  UNSPLASH_ACCESS_KEY: z.string().optional(),

  SARVAM_API_KEY: z.string().optional(),

  // Cashfree Verification Suite (PAN, bank/UPI penny drop, selfie liveness).
  // Without these, the automated verification endpoints answer 503 — they
  // never fake a "verified" result.
  CASHFREE_CLIENT_ID: z.string().optional(),
  CASHFREE_CLIENT_SECRET: z.string().optional(),
  CASHFREE_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  // Who decides an Aadhaar upload. 'admin' (default): both sides are stored and
  // an admin approves or rejects in the review queue. 'cashfree': Smart OCR
  // decides on the spot (billed per side).
  AADHAAR_VERIFICATION_MODE: z.enum(['admin', 'cashfree']).default('admin'),
  // Test-only: replaces the Cashfree verification base URL with a local stand-in.
  CASHFREE_VERIFICATION_BASE_URL: z.string().url().optional().or(z.literal('')),
  // Identity + selfie provider. 'admin' (default): the existing upload + admin
  // review flow. 'didit': Didit's hosted workflow session (free tier); the
  // outcome arrives on POST /api/verification/didit/webhook.
  KYC_PROVIDER: z.enum(['admin', 'didit']).default('admin'),
  DIDIT_API_KEY: z.string().optional(),
  DIDIT_WORKFLOW_ID: z.string().optional(),
  DIDIT_WEBHOOK_SECRET: z.string().optional(),
  // Test-only: replaces https://verification.didit.me with a local stand-in.
  DIDIT_BASE_URL: z.string().url().optional().or(z.literal('')),
  // Where Didit sends the user back after verifying (appends verificationSessionId and status).
  DIDIT_CALLBACK_URL: z.string().optional(),
  // Sandbox apps only; leave empty on a production app.
  DIDIT_SANDBOX_SCENARIO: z.string().optional(),
  // Test-only: replaces OpenStreetMap's Nominatim with a local stand-in.
  NOMINATIM_BASE_URL: z.string().url().optional().or(z.literal('')),
  NOMINATIM_MIN_GAP_MS: z.coerce.number().int().min(0).optional(),
  // Google Geocoding API (server-side key) — primary provider for "Find on map";
  // without it, OpenStreetMap is used alone.
  GOOGLE_MAPS_SERVER_KEY: z.string().optional(),
  // Test-only: replaces Google's Geocoding base URL with a local stand-in.
  GOOGLE_GEOCODE_BASE_URL: z.string().url().optional().or(z.literal('')),
  // Explore places (src/attractions). Places are imported from Wikidata,
  // which needs no key. This one is optional: without it only the admin
  // YouTube search answers 503 with a clear message; guests are unaffected.
  YOUTUBE_API_KEY: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  // Supabase's session-mode pooler hard-caps at 15 concurrent connections
  // — a default at or above that guarantees EMAXCONNSESSION errors under
  // any real concurrent load (see app.module.ts). Stays safely under it.
  DB_POOL_MAX: z.coerce.number().int().default(10),

  // TEST ONLY. Skips the LOCATION checks of in-app camera capture for listing
  // photos and the walkthrough video (the camera and the minimum video length
  // are still required). Refuses to boot when NODE_ENV=production.
  CAPTURE_LOCATION_BYPASS: envBoolean,

  // TEST ONLY. Lets a guest or host check out before the move-out date and the
  // listing's checkout time. Refuses to boot when NODE_ENV=production.
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
  return env;
}
