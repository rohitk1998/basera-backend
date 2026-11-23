import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('inquiry_messages')
export class InquiryMessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  inquiry_id: string;

  /** in = from guest, out = staff to guest (guest-visible), internal = staff note (never guest-visible). */
  @Column({ type: 'text' })
  direction: 'in' | 'out' | 'internal';

  @Column({ type: 'text', default: 'web' })
  channel: string;

  @Column({ type: 'text' })
  body: string;

  @Column('uuid', { nullable: true })
  actor_id: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  at: Date;
}
