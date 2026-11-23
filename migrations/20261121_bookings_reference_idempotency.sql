-- Human-readable booking reference (RB-XXXXXX) and per-guest idempotency key,
-- plus the pay-by deadline set when the host approves.
-- Idempotent. NOT applied automatically.

alter table bookings
  add column if not exists reference varchar(16),
  add column if not exists idempotency_key varchar(128),
  add column if not exists pay_by_at timestamptz;

-- Backfill existing rows (new rows get a reference from the app).
update bookings
   set reference = 'RB-' || upper(substr(md5(id::text), 1, 6))
 where reference is null;

-- Unique constraint name is relied on by the app to detect reference collisions.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_reference_key') then
    alter table bookings add constraint bookings_reference_key unique (reference);
  end if;
end $$;

-- A guest can replay the same Idempotency-Key only once; nulls are unconstrained.
create unique index if not exists bookings_guest_idempotency_key_uq
  on bookings (guest_id, idempotency_key)
  where idempotency_key is not null;

-- Lets expireStaleHolds find unpaid approvals cheaply.
create index if not exists bookings_confirmed_pay_by_idx
  on bookings (pay_by_at)
  where status = 'confirmed' and pay_by_at is not null;
