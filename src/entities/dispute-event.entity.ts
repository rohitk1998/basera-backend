import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Append-only negotiation/decision timeline, one row per action — the
// same shape as booking_events, kept separate from it because its
// to_status column is a booking-status transition, and jamming
// negotiation offers in there would overload it the same way
// bookings.rejection_reason was overloaded before this rebuild.
@Entity('dispute_events')
export class DisputeEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  dispute_case_id: string;

  @Column('uuid')
  actor_id: string;

  @Column()
  actor_role: string; // guest | host | admin | system

  @Column()
  event_type: string; // claim_raised | host_offer | guest_counter | host_counter | accepted | rejected | escalated | admin_decision | appeal_raised | appeal_decision

  @Column('int', { nullable: true })
  offer_amount: number | null;

  @Column({ type: 'text', nullable: true })
  message: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
