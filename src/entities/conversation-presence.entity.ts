import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('conversation_presence')
export class ConversationPresenceEntity {
  @PrimaryColumn('uuid')
  user_id: string;

  @PrimaryColumn('uuid')
  conversation_id: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  last_seen_at: Date;
}
