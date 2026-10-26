import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('dispute_cases')
export class DisputeCaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  booking_id: string;

  @Column()
  category: string;

  @Column('text')
  description: string;

  @Column('int')
  requested_amount: number;

  @Column({ type: 'date', nullable: true })
  leaving_on: string | null;

  @Column('text', { array: true, default: () => "'{}'" })
  evidence_urls: string[];

  @Column({ default: 'open' })
  case_status: string;

  @Column('int', { nullable: true })
  resolution_amount_to_guest: number | null;

  @Column({ type: 'text', nullable: true })
  resolved_by: string | null;

  @Column('int', { default: 0 })
  negotiation_rounds: number;

  @Column({ default: false })
  appeal_used: boolean;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at: Date;
}
