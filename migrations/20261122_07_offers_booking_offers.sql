-- Phase 6: host offer step between review and payment.
-- New booking statuses: host_review, offered, awaiting_payment.
-- Idempotent. NOT applied automatically (lead applies).

-- 1. Status CHECK (none existed before). NOT VALID so legacy rows are not scanned/blocked;
--    new writes are enforced. 'approved' is kept: the overlap constraint already lists it.
alter table bookings drop constraint if exists bookings_status_check;
alter table bookings
  add constraint bookings_status_check
  check (status in ('requested','host_review','offered','awaiting_payment','approved','confirmed',
                    'checked_in','checked_out','disputed','completed','declined','cancelled','expired'))
  not valid;

-- 2. awaiting_payment holds the dates (a guest accepted and is paying), so the
--    exclusion constraint must include it. Rebuild only if it does not already.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'bookings_no_overlap')
     and not exists (
       select 1 from pg_constraint
        where conname = 'bookings_no_overlap' and pg_get_constraintdef(oid) like '%awaiting_payment%'
     ) then
    alter table bookings drop constraint bookings_no_overlap;
    alter table bookings
      add constraint bookings_no_overlap
      exclude using gist (
        listing_id with =,
        daterange(move_in, coalesce(actual_move_out, move_out), '[)') with &&
      )
      where (status in ('awaiting_payment','confirmed','approved','checked_in','disputed','completed','checked_out'));
  end if;
end $$;

-- 3. Offers.
create table if not exists booking_offers (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  version int not null,
  price_snapshot jsonb not null,
  conditions text,
  host_message text,
  expires_at timestamptz not null,
  state text not null default 'pending'
    check (state in ('pending','accepted','declined','expired','superseded','withdrawn')),
  accepted_at timestamptz,
  created_by uuid,
  idempotency_key varchar(128),
  created_at timestamptz not null default now(),
  constraint booking_offers_booking_version_uq unique (booking_id, version)
);

-- At most one live offer per booking (the DB backstop for concurrent offers).
create unique index if not exists booking_offers_one_pending_uq
  on booking_offers (booking_id) where state = 'pending';

create unique index if not exists booking_offers_idempotency_uq
  on booking_offers (booking_id, idempotency_key) where idempotency_key is not null;

create index if not exists booking_offers_pending_expiry_idx
  on booking_offers (expires_at) where state = 'pending';

-- Expiry sweep for accepted-but-unpaid bookings.
create index if not exists bookings_awaiting_payment_pay_by_idx
  on bookings (pay_by_at) where status = 'awaiting_payment' and pay_by_at is not null;
