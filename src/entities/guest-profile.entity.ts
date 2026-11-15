import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('guest_profiles')
export class GuestProfileEntity {
  @PrimaryColumn('uuid')
  user_id: string;

  @Column({ type: 'boolean', default: false })
  visible: boolean;

  @Column({ type: 'text', nullable: true })
  headline: string | null;

  @Column({ type: 'text', nullable: true })
  home_country: string | null;

  @Column({ type: 'text', nullable: true })
  work_status: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at: Date;
}
