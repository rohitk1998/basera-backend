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
  status: string; // held | refunded | released_to_host

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at: Date;
}
