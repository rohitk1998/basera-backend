import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('meetup_members')
export class MeetupMemberEntity {
  @PrimaryColumn('uuid')
  meetup_id: string;

  @PrimaryColumn('uuid')
  user_id: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  joined_at: Date;
}
