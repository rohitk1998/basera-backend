import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConsentService } from '../notifications/consent.service';
import type { ContactChannel } from '../entities';
import { isPrimaryAdmin } from '../common/primary-admin';

@Injectable()
export class AdminLookupsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly consent: ConsentService,
  ) {}

  /** Active admins. Email is returned in full: this route is admin-only. */
  async staff() {
    const rows = await this.dataSource.query(
      `select id, full_name as name, email from users where role = 'admin' and banned_at is null order by full_name nulls last, id`,
    );
    const all = rows.map((r: any) => ({ id: r.id, name: r.name ?? null, email: r.email ?? null }));
    // Only the primary admin is offered in pickers (falls back to everyone if that account does not exist).
    const primary = all.filter((r: { email: string | null }) => isPrimaryAdmin(r.email));
    return { data: primary.length ? primary : all };
  }

  async consentFor(subjectType: string, subjectId: string, channel?: ContactChannel) {
    const rows = await this.consent.list(subjectType, subjectId, channel);
    return {
      data: rows.map((r) => ({
        channel: r.channel,
        status: r.consent_status,
        source: r.source,
        consentedAt: r.consented_at,
        revokedAt: r.revoked_at,
      })),
    };
  }

  async users(ids: string[]) {
    const unique = [...new Set(ids)].slice(0, 50);
    if (!unique.length) return [];
    const rows = await this.dataSource.query(`select id, full_name as name from users where id = any($1::uuid[])`, [unique]);
    return rows.map((r: any) => ({ id: r.id, name: r.name ?? null }));
  }
}
