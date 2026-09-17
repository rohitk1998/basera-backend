import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('users')
export class UserEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ type: 'text', nullable: true })
  full_name: string | null;

  @Column({ type: 'text', nullable: true })
  email: string | null;

  @Column({ type: 'text', nullable: true })
  phone: string | null;

  @Column({ type: 'text', nullable: true })
  avatar_url: string | null;

  @Column('text', { array: true, nullable: true })
  languages: string[] | null;

  @Column({ default: false })
  isHost: boolean;

  // The single source of truth for "is this user an admin" — never written
  // by any code path here, same as the Next.js app. An earlier draft
  // migration proposed a `roles text[]` column too, but per
  // 20260819_multi_role_profiles.sql it was never applied to any real
  // environment — the actual `profiles` table has only `role`. Do not add
  // a `roles` column back without confirming the migration actually ran.
  @Column({ type: 'text', nullable: true })
  role: string | null;

  // Admin-only credential — see 20260827_admin_password.sql. Every other
  // account type (guest/host) authenticates via Firebase phone-OTP and has
  // no password; this column is only ever set for role = 'admin' rows,
  // via the seed-admin CLI (never through user-facing signup).
  @Column({ type: 'text', nullable: true })
  password_hash: string | null;

  @Column({ type: 'text', nullable: true })
  host_kind: string | null;

  @Column({ type: 'text', nullable: true })
  pan: string | null;

  @Column({ type: 'text', nullable: true })
  gst: string | null;

  @Column({ type: 'text', nullable: true })
  registration_number: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  kyc_completed_at: Date | null;

  // Account-level verification, added alongside kyc_completed_at but
  // applicable to guests as well as hosts — see
  // verification-gate.util.ts. selfie_url is a Supabase Storage path
  // (bucket 'selfies'), not a public URL, same private-bucket pattern
  // as the KYC document uploads.
  @Column({ type: 'text', nullable: true })
  selfie_url: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  selfie_uploaded_at: Date | null;

  // Identity-proof banking — distinct from a listing's payout account
  // (draft_data.banking on `listings`). A host may route different
  // listings' rent to different accounts; this only proves the
  // account holder's bank-registered name matches their KYC identity.
  @Column({ type: 'text', nullable: true })
  bank_upi: string | null;

  @Column({ type: 'text', nullable: true })
  bank_account_name: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  bank_verified_at: Date | null;

  @Column({ default: true })
  notif_email: boolean;

  @Column({ default: true })
  notif_push: boolean;

  @Column('text', { array: true, default: () => "'{}'" })
  fcm_tokens: string[];

  @Column({ type: 'timestamptz', default: () => 'now()' })
  notif_updated_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  created_at: Date | null;

  // Synced from the web app's NEXT_LOCALE cookie when a logged-in user
  // changes language (see app/actions/locale.ts). Null means never set —
  // notification-sending code falls back to English, same as an unset
  // cookie does on the frontend.
  @Column({ type: 'text', nullable: true })
  preferred_locale: string | null;

  // Opaque refresh token for silently renewing an expired access token — see
  // AuthController.issueSession/refresh. Only the hash is ever persisted;
  // the raw token lives solely in the httpOnly refresh_token cookie.
  @Column({ type: 'text', nullable: true })
  refresh_token_hash: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  refresh_token_expires_at: Date | null;
}
