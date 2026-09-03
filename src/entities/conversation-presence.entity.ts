import { Column, Entity, PrimaryColumn } from 'typeorm';

// Heartbeat row, not Realtime Presence — see the migration's comment for
// why. Written only by the owning user via ConversationsService.heartbeat();
// read only by sendMessage()'s freshness check before firing a
// notification. Composite PK on (user_id, conversation_id) means multiple
// tabs for the same user naturally coalesce into one row.
@Entity('conversation_presence')
export class ConversationPresenceEntity {
  @PrimaryColumn('uuid')
  user_id: string;

  @PrimaryColumn('uuid')
  conversation_id: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  last_seen_at: Date;
}
