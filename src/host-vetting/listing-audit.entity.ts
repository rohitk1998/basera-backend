import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { AuditOutcome } from './host-vetting.constants';

/** Append-only periodic-audit notes. The service never updates or deletes rows. */
@Index(['listing_id', 'created_at'])
@Entity('listing_audits')
export class ListingAuditEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  listing_id: string;

  @Column('uuid')
  auditor_id: string;

  @Column('text')
  outcome: AuditOutcome;

  @Column('text')
  note: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
