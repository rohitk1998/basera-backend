import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Read directly by the browser via RLS + Supabase Realtime — this entity
// is only ever used server-side for the INSERT in
// ConversationsService.sendMessage(). Never add an update/delete path that
// isn't also mirrored by an RLS policy change; there is deliberately no
// write policy on this table, so a browser can never forge a message.
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

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
