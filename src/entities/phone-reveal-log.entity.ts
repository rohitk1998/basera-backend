import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Index(['guest_id', 'revealed_at'])
@Entity('phone_reveal_logs')
export class PhoneRevealLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  guest_id: string;

  @Column('uuid')
  host_id: string;

  @Column('uuid')
  listing_id: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  revealed_at: Date;

  @Column({ type: 'text', nullable: true })
  ip_hash: string | null;
}
