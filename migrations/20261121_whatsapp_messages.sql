-- WhatsApp message log (in/out). Consent lives in contact_preferences (channel 'whatsapp'), not here.
create table if not exists whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('in','out')),
  wa_message_id text not null unique,
  to_phone text,
  from_phone text,
  template_name text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','sent','delivered','read','failed')),
  error text,
  related_type text,
  related_id uuid,
  created_at timestamptz not null default now(),
  status_updated_at timestamptz
);
create index if not exists whatsapp_messages_related_idx on whatsapp_messages (related_type, related_id);
create index if not exists whatsapp_messages_to_phone_idx on whatsapp_messages (to_phone);
