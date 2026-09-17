-- Renames the profiles table to users. Safe to run now because the table
-- was just truncated (no data migration risk) — foreign keys, indexes, and
-- constraints are renamed along with it so nothing dangles.
alter table if exists profiles rename to users;

alter table if exists users rename constraint profiles_pkey to users_pkey;
alter table if exists users rename constraint profiles_email_key to users_email_key;

alter index if exists profiles_pkey rename to users_pkey;
