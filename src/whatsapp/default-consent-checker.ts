import { Injectable } from '@nestjs/common';
import { ConsentChecker } from './whatsapp.types';

/** Safe default: nobody has consented until the real ConsentService is bound. */
@Injectable()
export class DenyAllConsentChecker implements ConsentChecker {
  async hasGrantedConsent(): Promise<boolean> {
    return false;
  }
  async recordRevocation(): Promise<void> {
    /* no-op until contact_preferences is wired */
  }
}
