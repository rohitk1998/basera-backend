-- Real Cashfree orders: a payment now starts as `pending` (order created, guest
-- has not paid yet) and becomes `held` only when Cashfree reports the order PAID
-- (webhook or order-status check). `failed` is an order that expired or was
-- abandoned; the guest can start a fresh order on the same booking.
alter table payments drop constraint if exists payments_status_check;
alter table payments
  add constraint payments_status_check
  check (status in ('pending', 'failed', 'held', 'refunded', 'released_to_host', 'split'));

alter table payments add column if not exists cf_payment_id text;
alter table payments add column if not exists paid_at timestamptz;
-- Order ids are `bk_<booking>_<attempt>`; a retry after expiry bumps the attempt.
alter table payments add column if not exists attempt int not null default 1;

create unique index if not exists idx_payments_cashfree_order_id
  on payments (cashfree_order_id);
