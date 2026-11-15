import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('stay_chat_messages')
export class StayChatMessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  listing_id: string;

  @Column('uuid')
  sender_id: string;

  @Column('text')
  body: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
