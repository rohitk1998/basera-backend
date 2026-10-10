// Per-type status shape returned by GET /api/verification/status and by
// submit/resubmit. Deliberately excludes document_path and analysis_result
// internals — those are admin-only (or reachable by the user only via the
// separate signed-URL endpoint, never inlined here).
export interface NotStartedStatus {
  status: 'not_started';
  documentSubtype: null;
  rejectionReason: null;
  submittedAt: null;
  reviewedAt: null;
  hasBackDocument: false;
}

export interface IdentityOrPanStatus {
  id: string;
  status: 'pending' | 'verified' | 'rejected';
  documentSubtype: string | null;
  rejectionReason: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  // True only for an identity (Aadhaar) row with a back-side document stored.
  hasBackDocument: boolean;
}

export interface BankStatus extends IdentityOrPanStatus {
  bankAccountHolderName: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
}

export interface MyVerificationStatus {
  identity: NotStartedStatus | IdentityOrPanStatus;
  pan: NotStartedStatus | IdentityOrPanStatus;
  bank: NotStartedStatus | BankStatus;
  selfie: NotStartedStatus | IdentityOrPanStatus;
  // The user's verified UPI ID, or null. Set only by a successful UPI check.
  upiId: string | null;
  // Who verifies identity + selfie: Didit's hosted flow or the admin review queue.
  kycProvider: 'didit' | 'admin';
}
