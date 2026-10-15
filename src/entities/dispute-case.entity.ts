import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// One row per disputed booking (unique on booking_id) — the structured
// claim plus the current fine-grained state. `bookings.status` stays just
// 'disputed' for the whole lifecycle below; case_status is what actually
// tracks where things are. See dispute-event.entity.ts for the append-only
// negotiation/decision log this case accumulates.
@Entity('dispute_cases')
export class DisputeCaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  booking_id: string;

  @Column()
  category: string; // not_as_described | cleanliness | damage_safety | host_unresponsive_or_cancelled | early_departure | other

  @Column('text')
  description: string;

  @Column('int')
  requested_amount: number;

  /** early_departure only: the day the guest says they are leaving. */
  @Column({ type: 'date', nullable: true })
  leaving_on: string | null;

  @Column('text', { array: true, default: () => "'{}'" })
  evidence_urls: string[];

  @Column({ default: 'open' })
  case_status: string; // open | negotiating | escalated | admin_decided | appealed | resolved

  /** Set once resolved, by whichever path got there — the host's share is
   *  always `payment.amount - resolution_amount_to_guest`, never stored
   *  separately, so the two can never drift apart. */
  @Column('int', { nullable: true })
  resolution_amount_to_guest: number | null;

  @Column({ type: 'text', nullable: true })
  resolved_by: string | null; // negotiation | admin | appeal

  @Column('int', { default: 0 })
  negotiation_rounds: number;

  @Column({ default: false })
  appeal_used: boolean;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at: Date;
}
