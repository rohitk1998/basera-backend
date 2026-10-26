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

  @Column({ type: 'text', nullable: true })
  role: string | null;

  @Column({ type: 'text', nullable: true })
  password_hash: string | null;

  @Column({ type: 'text', nullable: true })
  host_kind: string | null;

  @Column({ type: 'text', nullable: true })
  gst: string | null;

  @Column({ type: 'text', nullable: true })
  selfie_url: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  selfie_uploaded_at: Date | null;

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

  @Column({ type: 'text', nullable: true })
  preferred_locale: string | null;

  @Column({ type: 'text', nullable: true })
  refresh_token_hash: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  refresh_token_expires_at: Date | null;
}
