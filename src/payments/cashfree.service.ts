import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const CASHFREE_VRS_API_VERSION = '2024-12-01';

// Smart OCR is asked for plain 'AADHAAR' and reports which side it found in
// the response's document_type (AADHAAR_FRONT / AADHAAR_BACK), so a user who
// uploads the sides in the wrong order is still handled.
const SMART_OCR_AADHAAR_DOCUMENT_TYPE = 'AADHAAR';

type Flags = Record<string, boolean | null>;

export interface AadhaarSideResult {
  side: 'front' | 'back' | 'unknown';
  /** Cashfree's own verdict. It is NOT proof the card passed — the flags below decide that. */
  valid: boolean;
  referenceId: string;
  fields: { uid: string | null; name: string | null; dob: string | null };
  quality: Flags;
  fraud: Flags;
  qr: { status: string; name: string | null; lastFour: string | null } | null;
}

/** Outcome of one Smart OCR call: a parsed result, or a reason the file itself was refused. */
export type AadhaarOcrOutcome = { ok: true; result: AadhaarSideResult } | { ok: false; reason: string };

export interface VerificationOutcome {
  verified: boolean;
  /** User-facing reason, set only when `verified` is false. */
  reason?: string;
  referenceId?: string;
  nameAtBank?: string | null;
  bankName?: string | null;
  nameMatchResult?: string;
}

@Injectable()
export class CashfreeService {
  private readonly logger = new Logger(CashfreeService.name);
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly environment: string;

  constructor(private readonly config: ConfigService) {
    this.clientId = this.config.get<string>('CASHFREE_CLIENT_ID');
    this.clientSecret = this.config.get<string>('CASHFREE_CLIENT_SECRET');
    this.environment = this.config.get<string>('CASHFREE_ENVIRONMENT') ?? 'sandbox';
  }

  private getBaseUrl(service: 'verification' | 'pg' | 'payout'): string {
    // Lets tests point the client at a local stand-in for Cashfree.
    const override = this.config.get<string>('CASHFREE_VERIFICATION_BASE_URL');
    if (service === 'verification' && override) return override.replace(/\/$/, '');
    const isSandbox = this.environment !== 'production';
    switch (service) {
      case 'verification':
        return isSandbox
          ? 'https://sandbox.cashfree.com/verification'
          : 'https://api.cashfree.com/verification';
      case 'pg':
        return isSandbox
          ? 'https://sandbox.cashfree.com/pg'
          : 'https://api.cashfree.com/pg';
      case 'payout':
        return isSandbox
          ? 'https://sandbox.cashfree.com/payout/v1'
          : 'https://payout-api.cashfree.com/payout/v1';
    }
  }

  private isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  /** Verification Suite calls need real credentials — never fake a "verified" result. */
  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Identity verification is not available right now. Please try again later.',
      );
    }
  }

  private isNameAcceptable(matchResult: string | undefined): boolean {
    return matchResult === 'DIRECT_MATCH' || matchResult === 'GOOD_PARTIAL_MATCH';
  }

  /**
   * One POST to the Verification Suite. A 400/409/422 from Cashfree is a
   * statement about the user's input (bad PAN, unknown account, ...) and is
   * returned as `{ ok: false }` so the caller can reject the submission with
   * that message. Auth, quota, rate-limit and 5xx failures are ours to fix,
   * not the user's, so they surface as a 503 instead.
   */
  private async postVerification(
    path: string,
    body: BodyInit,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ ok: true; data: any } | { ok: false; message: string; code?: string }> {
    let res: Response;
    try {
      res = await fetch(`${this.getBaseUrl('verification')}${path}`, {
        method: 'POST',
        headers: {
          'x-client-id': this.clientId!,
          'x-client-secret': this.clientSecret!,
          ...extraHeaders,
        },
        body,
      });
    } catch (e) {
      this.logger.error(`[Cashfree] ${path} request failed`, e as Error);
      throw new ServiceUnavailableException('Could not reach the verification service. Please try again.');
    }

    const data: any = await res.json().catch(() => ({}));
    if (res.ok) {
      return { ok: true, data };
    }
    if ([400, 409, 422].includes(res.status) && !this.isAccountProblem(data)) {
      return { ok: false, message: data?.message || 'The details could not be verified.', code: data?.code };
    }
    this.logger.error(`[Cashfree] ${path} -> ${res.status} ${data?.code ?? ''} ${data?.message ?? ''}`);
    throw new ServiceUnavailableException('Verification service is temporarily unavailable. Please try again.');
  }

  /**
   * Some 4xx answers are about OUR account, not the user's input: product not
   * enabled, wrong-environment keys, missing credentials, no balance. Those
   * must surface as "service unavailable" (so callers fall back or ask the
   * user to retry later) — never as "your document/details were rejected".
   */
  private isAccountProblem(data: any): boolean {
    const code = String(data?.code ?? '');
    const message = String(data?.message ?? '');
    return (
      code === 'insufficient_balance' ||
      code.startsWith('x-client') ||
      /not enabled|not activated|not subscribed|not allowed for this account|belongs to (test|production)/i.test(message)
    );
  }

  private json(payload: Record<string, unknown>): { body: string; headers: Record<string, string> } {
    return { body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } };
  }

  /**
   * Reads one photo of an Aadhaar card with Smart OCR (`/bharat-ocr`). A file
   * Cashfree rejects (unreadable, wrong type, too large) comes back as
   * `{ ok: false }` with a user-facing reason; auth, quota, rate-limit and
   * 5xx failures throw a 503 so the caller can fall back to manual review.
   */
  async readAadhaarImage(input: { image: Buffer; mimetype: string }): Promise<AadhaarOcrOutcome> {
    this.assertConfigured();

    // A repeated verification_id is refused with 409 — mint a new one and retry once.
    for (let attempt = 0; attempt < 2; attempt++) {
      const form = new FormData();
      form.append('verification_id', `aadhaar-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
      form.append('document_type', SMART_OCR_AADHAAR_DOCUMENT_TYPE);
      form.append(
        'file',
        new Blob([new Uint8Array(input.image)], { type: input.mimetype }),
        input.mimetype === 'application/pdf' ? 'aadhaar.pdf' : input.mimetype === 'image/png' ? 'aadhaar.png' : 'aadhaar.jpg',
      );

      const res = await this.postVerification('/bharat-ocr', form, { 'x-api-version': CASHFREE_VRS_API_VERSION });
      if (!res.ok) {
        if (res.code === 'verification_id_already_exists' && attempt === 0) continue;
        return { ok: false, reason: 'We could not read this file. Upload a clear JPEG, PNG or PDF photo of your Aadhaar, under 5 MB.' };
      }
      return { ok: true, result: this.parseAadhaarResult(res.data) };
    }
    return { ok: false, reason: 'We could not read this file. Please try again.' };
  }

  private parseAadhaarResult(d: any): AadhaarSideResult {
    const type = String(d?.document_type ?? '');
    const flags = (o: any): Flags =>
      Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, typeof v === 'boolean' ? v : null]));
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const qr = d?.qr_details;
    return {
      side: type.endsWith('FRONT') ? 'front' : type.endsWith('BACK') ? 'back' : 'unknown',
      valid: d?.status === 'VALID',
      referenceId: String(d?.reference_id ?? ''),
      fields: { uid: str(d?.document_fields?.uid), name: str(d?.document_fields?.name), dob: str(d?.document_fields?.dob) },
      quality: flags(d?.quality_checks),
      fraud: flags(d?.fraud_checks),
      qr: qr
        ? { status: String(qr.status ?? 'NOT_PRESENT'), name: str(qr.name), lastFour: str(qr.aadhaar_last_four_digit) }
        : null,
    };
  }

  /** Bank account penny drop (sync). Confirms the account exists and the holder name matches. */
  async verifyBankAccount(input: { accountNumber: string; ifsc: string; name: string }): Promise<VerificationOutcome> {
    this.assertConfigured();
    const { body, headers } = this.json({
      bank_account: input.accountNumber,
      ifsc: input.ifsc,
      name: input.name,
    });
    const res = await this.postVerification('/bank-account/sync', body, headers);
    if (!res.ok) return { verified: false, reason: res.message };

    const d = res.data;
    if (d.account_status !== 'VALID') {
      return { verified: false, reason: 'This bank account could not be verified. Check the account number and IFSC.' };
    }
    if (!this.isNameAcceptable(d.name_match_result)) {
      return { verified: false, reason: 'The account holder name does not match the name registered with your bank.' };
    }
    return {
      verified: true,
      referenceId: String(d.reference_id ?? ''),
      nameAtBank: d.name_at_bank ?? null,
      bankName: d.bank_name ?? d.ifsc_details?.bank ?? null,
      nameMatchResult: d.name_match_result,
    };
  }

  /** PAN check against the Income Tax database, with a name match. */
  async verifyPan(input: { pan: string; name: string }): Promise<VerificationOutcome> {
    this.assertConfigured();
    const { body, headers } = this.json({ pan: input.pan, name: input.name });
    const res = await this.postVerification('/pan', body, headers);
    if (!res.ok) return { verified: false, reason: res.message };

    const d = res.data;
    const valid = d.valid === true || d.pan_status === 'VALID' || d.status === 'VALID';
    if (!valid) {
      return { verified: false, reason: 'This PAN is not valid or is not active.' };
    }
    if (!this.isNameAcceptable(d.name_match_result)) {
      return { verified: false, reason: 'The name on this PAN does not match the name on your profile.' };
    }
    return {
      verified: true,
      referenceId: String(d.reference_id ?? ''),
      nameAtBank: d.registered_name ?? null,
      nameMatchResult: d.name_match_result,
    };
  }

  /** UPI penny drop: confirms the VPA is live and returns the name registered with the bank. */
  async verifyUpi(input: { vpa: string; name?: string; verificationId: string }): Promise<VerificationOutcome> {
    this.assertConfigured();
    const { body, headers } = this.json({
      verification_id: input.verificationId,
      vpa: input.vpa,
      ...(input.name ? { name: input.name } : {}),
      user_consent: {
        obtained: true,
        type: 'EXPLICIT',
        timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        purpose: 'Verify UPI ID for receiving Basera payouts',
      },
    });
    const res = await this.postVerification('/upi/penny-drop', body, { ...headers, 'x-api-version': CASHFREE_VRS_API_VERSION });
    if (!res.ok) return { verified: false, reason: res.message };

    const d = res.data;
    if (d.status !== 'VALID') {
      return { verified: false, reason: 'This UPI ID could not be verified.' };
    }
    if (input.name && d.name_match_result && !this.isNameAcceptable(d.name_match_result)) {
      return { verified: false, reason: 'The name registered with this UPI ID does not match your profile.' };
    }
    return {
      verified: true,
      referenceId: String(d.reference_id ?? ''),
      nameAtBank: d.name_at_bank ?? null,
      nameMatchResult: d.name_match_result,
    };
  }

  /** Selfie liveness check — confirms a single real face, not a photo of a photo. */
  async checkLiveness(input: { image: Buffer; mimetype: string; verificationId: string }): Promise<VerificationOutcome> {
    this.assertConfigured();
    const form = new FormData();
    form.append('verification_id', input.verificationId);
    form.append(
      'image',
      new Blob([new Uint8Array(input.image)], { type: input.mimetype }),
      input.mimetype === 'image/png' ? 'selfie.png' : 'selfie.jpg',
    );
    const res = await this.postVerification('/face-liveness', form, { 'x-api-version': CASHFREE_VRS_API_VERSION });
    if (!res.ok) return { verified: false, reason: res.message };

    const d = res.data;
    if (d.status === 'MULTIPLE_FACES_DETECTED') {
      return { verified: false, reason: 'More than one face was found. Take a selfie with only you in the frame.' };
    }
    if (d.status !== 'SUCCESS' || d.liveness !== true) {
      return { verified: false, reason: 'We could not confirm a live face. Retake the selfie in good light, facing the camera.' };
    }
    return { verified: true, referenceId: String(d.reference_id ?? ''), nameAtBank: null };
  }

  /**
   * Create Payment Gateway Order (Escrow / Hold & Release)
   */
  async createOrder(params: {
    orderId: string;
    amount: number;
    customerId: string;
    customerPhone: string;
    customerEmail?: string;
    split?: Array<{ vendor_id: string; amount: number }>;
  }) {
    if (!this.isConfigured()) {
      this.logger.warn('[Cashfree] Credentials not configured — returning simulated PG order');
      return {
        success: true,
        orderId: params.orderId,
        paymentSessionId: `session_simulated_${Date.now()}`,
        orderStatus: 'ACTIVE',
        message: 'Simulated order created successfully.',
      };
    }

    try {
      const url = `${this.getBaseUrl('pg')}/orders`;
      const payload: Record<string, any> = {
        order_id: params.orderId,
        order_amount: params.amount,
        order_currency: 'INR',
        customer_details: {
          customer_id: params.customerId,
          customer_phone: params.customerPhone,
          customer_email: params.customerEmail ?? 'guest@basera.in',
        },
      };

      if (params.split && params.split.length > 0) {
        payload.order_splits = params.split;
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'x-client-id': this.clientId!,
          'x-client-secret': this.clientSecret!,
          'x-api-version': '2023-08-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.message || 'Cashfree order creation failed');
      }

      return {
        success: true,
        orderId: data.order_id,
        paymentSessionId: data.payment_session_id,
        orderStatus: data.order_status,
        message: 'Cashfree order created successfully.',
      };
    } catch (e: any) {
      this.logger.error('[Cashfree] Order creation error', e);
      throw new Error(e?.message ?? 'Failed to create Cashfree order');
    }
  }

  /**
   * Payout Transfer (Release funds to host bank account)
   */
  async createPayout(params: {
    transferId: string;
    amount: number;
    beneficiaryName: string;
    beneficiaryAccount: string;
    beneficiaryIfsc: string;
  }) {
    if (!this.isConfigured()) {
      this.logger.warn('[Cashfree] Credentials not configured — returning simulated payout transfer');
      return {
        success: true,
        transferId: params.transferId,
        status: 'SUCCESS',
        referenceId: `SIMULATED-PAYOUT-${Date.now()}`,
        message: 'Simulated payout transfer completed successfully.',
      };
    }

    try {
      const url = `${this.getBaseUrl('payout')}/transfers`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Client-Id': this.clientId!,
          'X-Client-Secret': this.clientSecret!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          transfer_id: params.transferId,
          amount: params.amount,
          transfer_mode: 'banktransfer',
          beneficiary_details: {
            bank_account: params.beneficiaryAccount,
            ifsc: params.beneficiaryIfsc,
            name: params.beneficiaryName,
            email: 'host@basera.in',
            phone: '9999999999',
          },
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.message || 'Cashfree payout transfer failed');
      }

      return {
        success: true,
        transferId: data.transfer_id,
        status: data.status,
        referenceId: data.reference_id,
        message: data.message || 'Payout transfer initiated successfully.',
      };
    } catch (e: any) {
      this.logger.error('[Cashfree] Payout transfer error', e);
      throw new Error(e?.message ?? 'Failed to initiate Cashfree payout');
    }
  }
}
