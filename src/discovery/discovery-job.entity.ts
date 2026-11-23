import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type JobStatus = 'queued' | 'running' | 'paused' | 'cancelled' | 'done' | 'failed';

@Entity('discovery_jobs')
export class DiscoveryJobEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('text') destination: string;
  @Column('text', { array: true, default: () => "'{}'" }) categories: string[];
  @Column('text', { default: 'queued' }) status: JobStatus;
  @Column({ type: 'int', default: 0 }) requests_used: number;
  @Column({ type: 'int', default: 0 }) new_count: number;
  @Column({ type: 'int', default: 0 }) duplicate_count: number;
  @Column({ type: 'int', nullable: true }) max_new: number | null;
  @Column({ type: 'text', nullable: true }) error: string | null;
  @Column({ type: 'timestamptz', nullable: true }) started_at: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) finished_at: Date | null;
  @Column({ type: 'text', nullable: true }) lock_owner: string | null;
  @Column('text', { unique: true }) idempotency_key: string;
  @Column('uuid', { nullable: true }) created_by: string | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) created_at: Date;
}
