import { Column, Entity, PrimaryColumn } from 'typeorm';

// One row per email address currently mid-flow — a new send overwrites the
// previous row (see AuthController.sendEmailOtp) rather than appending,
// since only the latest code is ever valid. See
// web/supabase/migrations/20260916_email_otps.sql.
@Entity('email_otps')
export class EmailOtpEntity {
  @PrimaryColumn('text')
  email: string;

  // sha256 hash of the 6-digit code — never the raw code, same principle as
  // users.refresh_token_hash. Not bcrypt: this is short-lived, rate-limited
  // and attempt-capped, so bcrypt's per-hash cost buys nothing here.
  @Column({ type: 'text' })
  code_hash: string;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  // Wrong-guess counter — locks out at 5 (see verifyEmailOtp).
  @Column({ type: 'int', default: 0 })
  attempt_count: number;

  // Drives the 60s resend debounce in sendEmailOtp.
  @Column({ type: 'timestamptz', default: () => 'now()' })
  last_sent_at: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
