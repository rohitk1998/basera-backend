import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Scoped to (listing_id, guest_id) — one thread per guest per listing,
// reused across multiple booking attempts on the same listing. RLS on this
// table (see supabase/migrations/20260903_conversations_and_messages.sql)
// lets the browser read its own conversations directly; every write still
// goes through ConversationsService using the service-role connection.
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
