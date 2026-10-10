alter table if exists payments
  add column if not exists cashfree_split_payload jsonb;
