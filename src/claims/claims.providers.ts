import type { EntityManager } from 'typeorm';

/** Resolves a signed invitation token (CRM-owned table host_invitations) to a candidate listing. */
export interface InvitationLookup {
  /** Read-only check: valid = exists, not expired, not used. Returns null otherwise. */
  find(tokenHash: string): Promise<{ invitationId: string; listingId: string } | null>;
  /** Atomically marks the invitation used (single use). Returns false if already used/expired (replay). */
  consume(tokenHash: string, em: EntityManager, userId: string): Promise<boolean>;
}
export const CLAIM_INVITATION_LOOKUP = Symbol('CLAIM_INVITATION_LOOKUP');

/** Optional CRM hook; claims work without it. */
export interface CrmConversionHook {
  markConverted(listingId: string, userId?: string): Promise<unknown>;
}
export const CLAIM_CRM_HOOK = Symbol('CLAIM_CRM_HOOK');

/** Optional claimant notifier; claims work without it. Must never throw into the caller. */
export interface ClaimNotifier {
  notify(userId: string, event: 'claim.approved' | 'claim.rejected' | 'claim.more_info', data: { claimId: string; note?: string }): void;
}
export const CLAIM_NOTIFIER = Symbol('CLAIM_NOTIFIER');

export class SqlInvitationLookup implements InvitationLookup {
  constructor(private readonly query: (sql: string, params: unknown[]) => Promise<any[]>) {}

  async find(tokenHash: string) {
    const rows = await this.query(
      `SELECT i.id AS invitation_id, l.listing_id
         FROM host_invitations i JOIN host_leads l ON l.id = i.lead_id
        WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() AND l.listing_id IS NOT NULL
        LIMIT 1`,
      [tokenHash],
    ).catch(() => []); // table may not exist yet: behave as "invalid token"
    const r = rows[0];
    return r ? { invitationId: String(r.invitation_id), listingId: String(r.listing_id) } : null;
  }

  async consume(tokenHash: string, em: EntityManager, userId: string) {
    const rows: unknown = await em.query(
      `UPDATE host_invitations SET used_at = now(), used_by_user_id = $2
        WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING id`,
      [tokenHash, userId],
    );
    // pg driver returns [rows, count] for UPDATE via TypeORM; accept both shapes
    const arr = Array.isArray(rows) && Array.isArray(rows[0]) ? (rows[0] as unknown[]) : (rows as unknown[]);
    return arr.length > 0;
  }
}
