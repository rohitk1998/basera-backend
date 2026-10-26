import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('conversations')
export class ConversationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  listing_id: string;

  @Column('uuid')
  guest_id: string;

  @Column('uuid')
  host_id: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  last_message_at: Date;
}
