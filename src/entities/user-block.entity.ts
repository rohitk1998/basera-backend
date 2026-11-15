import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('user_blocks')
export class UserBlockEntity {
  @PrimaryColumn('uuid')
  blocker_id: string;

  @PrimaryColumn('uuid')
  blocked_id: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
