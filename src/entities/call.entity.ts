import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// A row exists purely for ring/missed-call history and to trigger the
// 'call.incoming' push notification — the actual audio/video never
// touches this table or this server. WebRTC signaling (SDP offer/answer,
// ICE candidates) happens over an ephemeral Supabase Realtime broadcast
// channel, never persisted.
@Entity('calls')
export class CallEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  conversation_id: string;

  @Column('uuid')
  caller_id: string;

  @Column('uuid')
  callee_id: string;

  @Column()
  kind: string; // voice | video

  @Column({ default: 'ringing' })
  status: string; // ringing | accepted | declined | missed | ended

  @Column({ type: 'timestamptz', default: () => 'now()' })
  started_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  ended_at: Date | null;
}
