import { z } from 'zod';

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

  UNSPLASH_ACCESS_KEY: z.string().optional(),

  SARVAM_API_KEY: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  // Supabase's session-mode pooler hard-caps at 15 concurrent connections
  // — a default at or above that guarantees EMAXCONNSESSION errors under
  // any real concurrent load (see app.module.ts). Stays safely under it.
  DB_POOL_MAX: z.coerce.number().int().default(10),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
