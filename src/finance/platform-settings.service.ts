import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export const SETTING_FREE_LISTING_CAP = 'free_listing_cap';
export const SETTING_ADJUSTMENT_THRESHOLD = 'adjustment_second_approval_threshold';
export const DEFAULT_FREE_LISTING_CAP = 100;

/** Keys that may be written through the admin API, with a validator each. */
export const WRITABLE_SETTINGS: Record<string, (v: unknown) => boolean> = {
  [SETTING_FREE_LISTING_CAP]: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000,
  [SETTING_ADJUSTMENT_THRESHOLD]: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100_000_000,
};

@Injectable()
export class PlatformSettingsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    try {
      const rows = await this.dataSource.query('select value from platform_settings where key = $1', [key]);
      return rows.length ? (rows[0].value as T) : fallback;
    } catch {
      return fallback;
    }
  }

  async all(): Promise<Record<string, unknown>> {
    const rows: { key: string; value: unknown }[] = await this.dataSource.query('select key, value from platform_settings order by key');
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async set(key: string, value: unknown, actor: string): Promise<void> {
    await this.dataSource.query(
      `insert into platform_settings (key, value, updated_by, updated_at) values ($1, $2::jsonb, $3, now())
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), actor],
    );
  }
}
