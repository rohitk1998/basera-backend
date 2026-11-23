import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

export type ContactChannel = 'email' | 'push' | 'whatsapp' | 'sms';
export type ConsentStatus = 'granted' | 'revoked' | 'unknown';

@Entity('contact_preferences')
@Unique(['subject_type', 'subject_id', 'channel'])
export class ContactPreferenceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** e.g. 'user' | 'host_lead' */
  @Column({ type: 'text' })
  subject_type: string;

  @Column({ type: 'text' })
  subject_id: string;

  @Column({ type: 'text' })
  channel: ContactChannel;

  @Column({ type: 'text', default: 'unknown' })
  consent_status: ConsentStatus;

  @Column({ type: 'timestamptz', nullable: true })
  consented_at: Date | null;

  @Column({ type: 'text', nullable: true })
  source: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  revoked_at: Date | null;
}
