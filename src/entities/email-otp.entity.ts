import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('email_otps')
export class EmailOtpEntity {
  @PrimaryColumn('text')
  email: string;

  @Column({ type: 'text' })
  code_hash: string;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @Column({ type: 'int', default: 0 })
  attempt_count: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  last_sent_at: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
