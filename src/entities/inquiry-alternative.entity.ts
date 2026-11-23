import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('inquiry_alternatives')
export class InquiryAlternativeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  inquiry_id: string;

  /** Always a verified live listing. */
  @Column('uuid')
  listing_id: string;

  @Column('uuid', { nullable: true })
  suggested_by: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  at: Date;
}
