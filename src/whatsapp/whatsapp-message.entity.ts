import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('whatsapp_messages')
export class WhatsappMessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  direction: 'in' | 'out';

  @Column({ type: 'text', unique: true })
  wa_message_id: string;

  @Column({ type: 'text', nullable: true })
  to_phone: string | null;

  @Column({ type: 'text', nullable: true })
  from_phone: string | null;

  @Column({ type: 'text', nullable: true })
  template_name: string | null;

  @Column('jsonb', { default: () => "'{}'" })
  payload: Record<string, unknown>;

  @Column({ type: 'text', default: 'queued' })
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'text', nullable: true })
  related_type: string | null;

  @Column({ type: 'uuid', nullable: true })
  related_id: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  status_updated_at: Date | null;
}
