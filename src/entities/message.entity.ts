import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('messages')
export class MessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  conversation_id: string;

  @Column('uuid')
  sender_id: string;

  @Column('text')
  body: string;

  @Column({ default: 'text' })
  type: string;

  @Column('uuid', { nullable: true })
  call_id: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
