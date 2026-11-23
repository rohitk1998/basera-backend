import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** A date range imported from the host's external calendar. `ends_on` is exclusive. */
@Index(['listing_id', 'starts_on', 'ends_on'])
@Entity('listing_calendar_blocks')
export class ListingCalendarBlockEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  listing_id: string;

  @Column({ type: 'text' })
  uid: string;

  @Column('date')
  starts_on: string;

  @Column('date')
  ends_on: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
