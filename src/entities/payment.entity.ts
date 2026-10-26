import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('payments')
export class PaymentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column('uuid')
  booking_id: string;

  @Column('int')
  amount: number;

  @Column()
  cashfree_order_id: string;

  @Column({ type: 'text', nullable: true })
  cashfree_payout_id: string | null;

  @Column()

  status: string;

  @Column('int', { nullable: true })
  split_amount_to_guest: number | null;

  @Column({ type: 'jsonb', nullable: true })
  cashfree_split_payload: {
    cashfree_split_order_id: string;
    splits: { vendor_id: string; amount: number }[];
    platform_amount: number;
  } | null;

  @Column({ type: 'text', nullable: true })
  cf_payment_id: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  paid_at: Date | null;

  @Column('int', { default: 1 })
  attempt: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at: Date;
}
