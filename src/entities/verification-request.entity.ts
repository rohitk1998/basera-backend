import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// One row per verification submission, across all four verification
// types (identity / pan / bank / legal) via the `verification_type`
// discriminator — see migrations/20260913_verification_requests.sql for
// the full rationale. A row only exists once a user has submitted
// something: there is no "not_started" status — that state is the
// absence of any row for a given (user_id, verification_type). The most
// recent row per (user_id, verification_type) is always the current
// status; older rows are resubmission history and are intentionally
// never overwritten (no unique constraint on that pair).
@Entity('verification_requests')
export class VerificationRequestEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  user_id: string;

  @Column()
  verification_type: string; // identity | pan | bank | legal

  @Column({ type: 'text', nullable: true })
  document_subtype: string | null; // identity only: aadhaar | passport | driving_licence

  @Column({ default: 'pending' })
  status: string; // pending | verified | rejected

  // Storage path in the private "verification-documents" bucket, shaped
  // {userId}/{verificationType}/{randomUUID()}.{ext}. Nullable — a bank
  // submission may carry only account details, no document.
  @Column({ type: 'text', nullable: true })
  document_path: string | null;

  // Bank-specific fields, only populated when verification_type = 'bank'.
  // UPI/account-holder-name identity checks stay on profiles
  // (bank_upi, bank_account_name) — these are the fields that table
  // does not already have.
  @Column({ type: 'text', nullable: true })
  bank_account_number: string | null;

  @Column({ type: 'text', nullable: true })
  bank_ifsc: string | null;

  @Column({ type: 'text', nullable: true })
  bank_account_holder_name: string | null;

  @Column({ type: 'text', nullable: true })
  bank_name: string | null;

  // Legal-specific field, only populated when verification_type = 'legal'.
  // HP Tourism registration number (format HP/HS/1234/2025); the
  // certificate itself is the row's document_path, same as every other
  // document-based verification type.
  @Column({ type: 'text', nullable: true })
  registration_number: string | null;

  // Output of DocumentAnalysisService — structural/quality signals only,
  // never extracted sensitive field values (no PAN/aadhaar/account
  // numbers). See src/verification/document-analysis.service.ts.
  @Column({ type: 'jsonb', nullable: true })
  analysis_result: Record<string, unknown> | null;

  // Required by app logic (not a DB constraint) whenever status = 'rejected'.
  @Column({ type: 'text', nullable: true })
  rejection_reason: string | null;

  @Column({ type: 'uuid', nullable: true })
  reviewed_by: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewed_at: Date | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  submitted_at: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at: Date;
}
