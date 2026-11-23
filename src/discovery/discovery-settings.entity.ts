import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('discovery_settings')
export class DiscoverySettingsEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('text', { unique: true }) destination: string;
  @Column('text', { array: true }) categories: string[];
  @Column({ type: 'int', default: 50 }) max_new_per_run: number;
  @Column({ type: 'int', default: 100 }) daily_request_budget: number;
  @Column({ type: 'text', nullable: true }) schedule_cron: string | null;
  @Column({ type: 'boolean', default: false }) paused: boolean;
  @Column('uuid', { nullable: true }) updated_by: string | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) updated_at: Date;
}
