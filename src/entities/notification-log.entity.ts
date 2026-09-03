import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('notification_log')
export class NotificationLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  user_id: string;

  @Column()
  event: string;

  @Column()
  channel: string; // email | push

  @Column()
  status: string; // sent | failed | skipped

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column('jsonb', { default: () => "'{}'" })
  payload: Record<string, unknown>;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  sent_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  read_at: Date | null;
}
