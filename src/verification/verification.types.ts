export interface NotStartedStatus {
  status: 'not_started';
  documentSubtype: null;
  rejectionReason: null;
  submittedAt: null;
  reviewedAt: null;
  hasBackDocument: false;
}

export interface VerificationRowStatus {
  id: string;
  status: 'pending' | 'verified' | 'rejected';
  documentSubtype: string | null;
  rejectionReason: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  hasBackDocument: boolean;
}

export interface MyVerificationStatus {
  identity: NotStartedStatus | VerificationRowStatus;
  selfie: NotStartedStatus | VerificationRowStatus;
}
