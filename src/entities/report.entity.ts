import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type ReportTargetType = 'user' | 'story' | 'message' | 'meetup';
export type ReportStatus = 'open' | 'reviewed' | 'dismissed';

@Entity('reports')
export class ReportEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  reporter_id: string;

  @Column({ type: 'text' })
  target_type: ReportTargetType;

  @Column('uuid')
  target_id: string;

  @Column({ type: 'text' })
  reason: string;

  @Column({ type: 'text', default: 'open' })
  status: ReportStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
