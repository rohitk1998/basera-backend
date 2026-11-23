-- Phase 7: commission agreements, double-entry ledger, refunds, payouts,
-- finance adjustments, platform settings, finance audit log. Idempotent.
create extension if not exists btree_gist;
create extension if not exists pgcrypto;

create table if not exists platform_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
insert into platform_settings (key, value) values
  ('free_listing_cap', '100'::jsonb),
  ('adjustment_second_approval_threshold', '0'::jsonb)
on conflict (key) do nothing;

create table if not exists commission_agreements (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('global','host','property')),
  scope_id uuid,
  rate_bps int not null check (rate_bps between 0 and 3000),
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  free_period_cap int check (free_period_cap is null or free_period_cap >= 0),
  reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  check ((scope = 'global') = (scope_id is null)),
  check (effective_to is null or effective_to > effective_from),
  constraint commission_agreements_no_overlap exclude using gist (
    scope with =,
    (coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
    tstzrange(effective_from, effective_to) with &&
  )
);
insert into commission_agreements (scope, scope_id, rate_bps, effective_from, reason)
select 'global', null, 0, '2026-01-01T00:00:00Z', 'free launch period'
where not exists (select 1 from commission_agreements where scope = 'global');

alter table bookings add column if not exists commission_rate_bps int;
alter table bookings add column if not exists commission_agreement_id uuid references commission_agreements(id);

create table if not exists ledger_entries (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid,
  payment_id uuid,
  entry_group uuid not null,
  line_no int not null default 1,
  kind text not null,
  idem_key text not null,
  account text not null check (account in ('guest_receivable','platform_cash','host_payable','platform_commission','refunds','adjustments')),
  debit int not null default 0 check (debit >= 0),
  credit int not null default 0 check (credit >= 0),
  currency text not null default 'INR',
  ref text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check ((debit > 0) <> (credit > 0)),
  unique (entry_group, line_no),
  unique (idem_key, line_no)
);
create index if not exists idx_ledger_booking on ledger_entries (booking_id);
create index if not exists idx_ledger_payment on ledger_entries (payment_id);
create index if not exists idx_ledger_account on ledger_entries (account);

create or replace function ledger_assert_balanced() returns trigger as $$
declare d bigint; c bigint;
begin
  select coalesce(sum(debit),0), coalesce(sum(credit),0) into d, c
    from ledger_entries where entry_group = new.entry_group;
  if d <> c then
    raise exception 'ledger entry_group % unbalanced: debit % <> credit %', new.entry_group, d, c;
  end if;
  return null;
end $$ language plpgsql;
drop trigger if exists trg_ledger_balanced on ledger_entries;
create constraint trigger trg_ledger_balanced
  after insert on ledger_entries
  deferrable initially deferred
  for each row execute function ledger_assert_balanced();

create or replace function ledger_append_only() returns trigger as $$
begin
  raise exception 'ledger_entries is append-only';
end $$ language plpgsql;
drop trigger if exists trg_ledger_append_only on ledger_entries;
create trigger trg_ledger_append_only
  before update or delete on ledger_entries
  for each row execute function ledger_append_only();

create table if not exists refunds (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null,
  payment_id uuid not null,
  amount int not null check (amount > 0),
  state text not null default 'requested' check (state in ('requested','pending','success','failed')),
  provider text not null default 'cashfree' check (provider in ('cashfree','legacy')),
  reason text,
  cf_refund_id text,
  cf_refund_status text,
  failure_reason text,
  attempts int not null default 0,
  requested_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists idx_refunds_booking on refunds (booking_id);
create index if not exists idx_refunds_state on refunds (state);

create table if not exists payouts (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null,
  payment_id uuid not null unique,
  host_id uuid not null,
  amount int not null check (amount >= 0),
  state text not null default 'pending' check (state in ('pending','approved','processing','paid','failed')),
  provider text not null default 'manual',
  bank_reference text,
  failure_reason text,
  approved_by uuid,
  approved_at timestamptz,
  paid_by uuid,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_payouts_host on payouts (host_id);
create index if not exists idx_payouts_state on payouts (state);

create table if not exists finance_adjustments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid,
  host_id uuid not null,
  direction text not null check (direction in ('host_credit','host_debit')),
  amount int not null check (amount > 0),
  reason text not null,
  state text not null default 'pending' check (state in ('pending','approved','rejected')),
  requires_second_approval boolean not null default true,
  requested_by uuid not null,
  approved_by uuid,
  decision_note text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (approved_by is null or not requires_second_approval or approved_by <> requested_by)
);
create index if not exists idx_fin_adj_state on finance_adjustments (state);

create table if not exists finance_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor uuid,
  action text not null,
  entity text not null,
  entity_id text,
  data jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists idx_fin_audit_entity on finance_audit_log (entity, entity_id);
