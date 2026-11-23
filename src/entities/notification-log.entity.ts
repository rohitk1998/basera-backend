import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('notification_log')
export class NotificationLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  user_id: string;

  @Column()
  event: string;

  /** 'in_app' = the feed row; 'email' | 'push' = real delivery attempts. */
  @Column()
  channel: 'in_app' | 'email' | 'push' | string;

  @Column()
  status: string;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column('jsonb', { default: () => "'{}'" })
  payload: Record<string, unknown>;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  sent_at: Date;

  @Column({ type: 'text', nullable: true })
  dedupe_key: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  read_at: Date | null;
}
