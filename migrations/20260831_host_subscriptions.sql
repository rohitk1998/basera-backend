-- ============================================================
-- Host subscriptions
--
-- Basera's revenue model is moving from "no commission, ever" to
-- "hosts subscribe, guests still see no per-booking fee." This table
-- is the one subscription relationship a host has with Basera — it
-- doubles as the existing listing-visibility tier (listed/featured/pro,
-- see web/lib/plans.ts) and the commission-replacement relationship,
-- rather than tracking those as two separate concepts.
--
-- No real Cashfree/Razorpay billing yet: cashfree_subscription_id is a
-- SIMULATED-{uuid} placeholder written by application code until a real
-- gateway integration lands. `past_due` exists for forward-compatibility
-- but nothing in this phase transitions a row into it (no real billing
-- to fail against).
--
-- Every guest booking gets the 24h payment-hold/auto-release flow
-- regardless of the host's plan_id/status here — this table gates
-- visibility/lead-alert perks only, never payment safety.
--
-- Idempotent — safe to re-run.
-- ============================================================

create table if not exists host_subscriptions (
  id                        uuid        primary key default gen_random_uuid(),
  host_id                   uuid        not null references profiles(id) on delete cascade,
  plan_id                   text        not null check (plan_id in ('listed', 'featured', 'pro')),
  status                    text        not null check (status in ('active', 'cancelled', 'past_due')),
  cashfree_subscription_id  text,
  amount                    int         not null,
  current_period_start      timestamptz not null default now(),
  current_period_end        timestamptz not null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists host_subscriptions_host_id_idx on host_subscriptions (host_id);

-- Following the established pattern (see 20260829_booking_escrow_payment.sql
-- in web/supabase/migrations/): no RLS on this table. Authorization is
-- handled in the NestJS API layer (AuthGuard + host_id ownership checks),
-- same as bookings/payments.
