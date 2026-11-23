import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConsentService } from '../notifications/consent.service';
import type { ConsentChecker } from '../whatsapp/whatsapp.types';
import { applyOptOutByPhone } from './crm-sql';

/**
 * Real implementation of the WhatsApp CONSENT_CHECKER seam, backed by contact_preferences.
 * Consent is keyed ('phone', <E.164>, 'whatsapp'). A host lead flagged DO_NOT_CONTACT for that number
 * blocks the send even if a stale grant row exists (defence in depth, enforced at the service layer).
 */
@Injectable()
export class WhatsappConsentChecker implements ConsentChecker {
  private readonly logger = new Logger(WhatsappConsentChecker.name);
  constructor(private readonly consent: ConsentService, private readonly db: DataSource) {}

  async hasGrantedConsent(phoneE164: string): Promise<boolean> {
    if (!(await this.consent.isAllowed('phone', phoneE164, 'whatsapp'))) return false;
    try {
      const rows = await this.db.query(`SELECT 1 FROM host_leads WHERE phone = $1 AND contact_state = 'DO_NOT_CONTACT' LIMIT 1`, [phoneE164]);
      return rows.length === 0;
    } catch (e: any) {
      this.logger.warn(`DNC lookup failed, denying send: ${e?.message}`);
      return false;
    }
  }

  async recordRevocation(phoneE164: string, source: string): Promise<void> {
    await this.consent.set('phone', phoneE164, 'whatsapp', 'revoked', source);
    await applyOptOutByPhone(this.db, phoneE164, source);
  }
}
