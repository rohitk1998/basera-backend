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

  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  APP_URL: z.string().default('https://basera.in'),

  UNSPLASH_ACCESS_KEY: z.string().optional(),

  SARVAM_API_KEY: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  DB_POOL_MAX: z.coerce.number().int().default(20),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  return envSchema.parse(config);
}
