import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('host_subscriptions')
export class HostSubscriptionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  host_id: string;

  @Column()
  plan_id: string; // listed | featured | pro

  @Column()
  status: string; // active | cancelled | past_due

  @Column({ type: 'text', nullable: true })
  cashfree_subscription_id: string | null;

  @Column('int')
  amount: number;

  @Column({ type: 'timestamptz' })
  current_period_start: Date;

  @Column({ type: 'timestamptz' })
  current_period_end: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at: Date;
}
