import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Storage-only usage (buckets, signed URLs) — all row data goes through
// TypeORM. This mirrors the Next.js app's pattern of a fresh service-role
// client for anything Postgres/PostgREST can't already do via the ORM.
@Injectable()
export class SupabaseProvider {
  readonly client: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    this.client = createClient(
      this.config.get<string>('NEXT_PUBLIC_SUPABASE_URL')!,
      this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY')!,
    );
  }
}
