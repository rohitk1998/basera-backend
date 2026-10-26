import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

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
