-- Phase 2 host acquisition CRM. Idempotent.
create table if not exists host_leads (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references listings(id) on delete cascade,
  contact_state text not null default 'NOT_CONTACTED'
    check (contact_state in ('NOT_CONTACTED','CONTACT_ATTEMPTED','CONTACTED','INTERESTED','INVITED','ONBOARDING','CONVERTED','DECLINED','DO_NOT_CONTACT')),
  owner_staff_id uuid,
  phone text,
  email text,
  contact_name text,
  property_hint text,
  source text not null check (source in ('google_public','host_self_registered','referral','manual')),
  next_action_at timestamptz,
  last_contacted_at timestamptz,
  first_contacted_at timestamptz,
  interested_at timestamptz,
  invited_at timestamptz,
  onboarding_at timestamptz,
  converted_at timestamptz,
  declined_at timestamptz,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists host_leads_listing_uq on host_leads (listing_id);
create index if not exists host_leads_state_idx on host_leads (contact_state);
create index if not exists host_leads_owner_idx on host_leads (owner_staff_id);
create index if not exists host_leads_next_action_idx on host_leads (next_action_at) where next_action_at is not null;
create index if not exists host_leads_phone_idx on host_leads (phone);

create table if not exists outreach_attempts (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references host_leads(id) on delete cascade,
  channel text not null check (channel in ('call','email','whatsapp','sms','visit','self_registration')),
  direction text not null default 'outbound' check (direction in ('outbound','inbound')),
  template text,
  provider_message_id text,
  status text not null default 'logged',
  outcome text,
  payload jsonb not null default '{}'::jsonb,
  created_by uuid,
  at timestamptz not null default now()
);
create index if not exists outreach_attempts_lead_idx on outreach_attempts (lead_id, at desc);

create table if not exists host_invitations (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references host_leads(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_user_id uuid,
  revoked_at timestamptz,
  created_by uuid,
  channel text not null default 'manual',
  resend_count int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists host_invitations_lead_idx on host_invitations (lead_id);

create table if not exists follow_up_tasks (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references host_leads(id) on delete cascade,
  due_at timestamptz not null,
  assignee_id uuid,
  kind text not null default 'call',
  done_at timestamptz,
  done_by uuid,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists follow_up_tasks_open_idx on follow_up_tasks (assignee_id, due_at) where done_at is null;
create index if not exists follow_up_tasks_lead_idx on follow_up_tasks (lead_id);
