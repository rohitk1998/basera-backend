import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('payments')
export class PaymentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  booking_id: string;

  @Column('int')
  amount: number;

  @Column()
  cashfree_order_id: string;

  @Column({ type: 'text', nullable: true })
  cashfree_payout_id: string | null;

  @Column()
  status: string; // held | refunded | released_to_host | split

  /** Only set when `status` is `split` — a dispute resolved for some
   *  amount to each party rather than all-or-nothing. The host's share is
   *  always `amount - split_amount_to_guest`, never stored separately. */
  @Column('int', { nullable: true })
  split_amount_to_guest: number | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at: Date;
}
