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
}

export interface IdentityOrPanStatus {
  id: string;
  status: 'pending' | 'verified' | 'rejected';
  documentSubtype: string | null;
  rejectionReason: string | null;
  submittedAt: string;
  reviewedAt: string | null;
}

export interface BankStatus extends IdentityOrPanStatus {
  bankAccountHolderName: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
}

export interface LegalStatus extends IdentityOrPanStatus {
  registrationNumber: string | null;
}

export interface MyVerificationStatus {
  identity: NotStartedStatus | IdentityOrPanStatus;
  pan: NotStartedStatus | IdentityOrPanStatus;
  bank: NotStartedStatus | BankStatus;
  legal: NotStartedStatus | LegalStatus;
  selfie: NotStartedStatus | IdentityOrPanStatus;
}
