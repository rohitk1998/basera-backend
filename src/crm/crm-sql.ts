import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { ContactState, DISCOVERY_MAP } from './crm.types';

const logger = new Logger('CrmSql');
/** pg UPDATE/DELETE ... RETURNING via TypeORM yields [rows, affected]; INSERT/SELECT yield rows. Normalise. */
export function rowsOf(r: any): any[] {
  if (Array.isArray(r) && r.length === 2 && Array.isArray(r[0]) && typeof r[1] === 'number') return r[0];
  return Array.isArray(r) ? r : [];
}

type Runner = Pick<DataSource, 'query'> | Pick<EntityManager, 'query'>;

/**
 * Move listings.discovery_state for a candidate, guarded by a from-state check done IN the UPDATE
 * (no read-modify-write race). Returns true when a row changed. Never throws: the discovery column may
 * not be deployed yet, and a failed sync must not roll back the CRM write.
 */
export async function syncDiscoveryState(db: Runner, listingId: string | null, leadState: ContactState): Promise<boolean> {
  const map = DISCOVERY_MAP[leadState];
  if (!listingId || !map) return false;
  try {
    const rows = await db.query(
      `UPDATE listings SET discovery_state = $1
         WHERE id = $2 AND is_discovered = true AND discovery_state = ANY($3::text[])
         RETURNING id`,
      [map.to, listingId, map.from],
    );
    return rowsOf(rows).length > 0;
  } catch (e: any) {
    logger.warn(`discovery_state sync skipped for ${listingId}: ${e?.message ?? e}`);
    return false;
  }
}

/**
 * STOP / opt-out by phone number. Raw SQL on purpose so the WhatsApp consent adapter can call it
 * without depending on CrmService (avoids a module cycle). Idempotent.
 */
export async function applyOptOutByPhone(db: DataSource, phone: string, source: string): Promise<number> {
  const leads: { id: string; listing_id: string | null }[] = rowsOf(await db.query(
    `UPDATE host_leads SET contact_state = 'DO_NOT_CONTACT', next_action_at = NULL, updated_at = now()
       WHERE phone = $1 AND contact_state <> 'DO_NOT_CONTACT'
       RETURNING id, listing_id`,
    [phone],
  ));
  for (const l of leads) {
    await db.query(`UPDATE host_invitations SET revoked_at = now() WHERE lead_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [l.id]);
    await db.query(`UPDATE follow_up_tasks SET done_at = now(), note = coalesce(note || ' | ', '') || 'closed: opted out' WHERE lead_id = $1 AND done_at IS NULL`, [l.id]);
    await db.query(
      `INSERT INTO contact_preferences (subject_type, subject_id, channel, consent_status, source, revoked_at)
         SELECT 'host_lead', $1, c, 'revoked', $2, now() FROM unnest(ARRAY['email','whatsapp','sms']) c
       ON CONFLICT (subject_type, subject_id, channel) DO UPDATE SET consent_status = 'revoked', revoked_at = now(), source = $2`,
      [l.id, source],
    ).catch((e) => logger.warn(`lead consent revoke failed: ${e?.message}`));
    await db.query(
      `INSERT INTO outreach_attempts (lead_id, channel, direction, status, outcome, payload) VALUES ($1,'whatsapp','inbound','received','opt_out',$2::jsonb)`,
      [l.id, JSON.stringify({ source })],
    );
    await syncDiscoveryState(db, l.listing_id, 'DO_NOT_CONTACT');
  }
  return leads.length;
}
