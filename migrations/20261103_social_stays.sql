-- Social layer for guests on 7+ night stays: events, stories, who-is-here
-- profiles, meetups, stay chat, blocks and reports. See src/events/,
-- src/stories/ and src/social/.
--
-- Additive only: creates new tables, touches no existing table or row.
-- Idempotent - safe to re-run.
--
-- RLS: like attractions and the other backend-only tables, row level
-- security is enabled with no policies. The Nest backend connects with the
-- database owner role and enforces access itself (AuthGuard, AdminGuard,
-- SocialAccessService); the Supabase anon/authenticated roles get nothing.
begin;

create extension if not exists pgcrypto;

-- Local events shown on the home page and the town pages.
create table if not exists events (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  title       text not null,
  description text not null default '',
  town        text not null,
  district    text not null,
  starts_on   date not null,
  ends_on     date not null,
  lat         double precision,
  lng         double precision,
  image_url   text,
  status      text not null default 'draft' check (status in ('draft', 'published')),
  created_at  timestamptz not null default now()
);
create index if not exists idx_events_status_starts_on on events (status, starts_on);
create index if not exists idx_events_town on events (town);

-- Guest stories. Public only when status = 'published' AND marketing_consent;
-- withdrawing consent sets status = 'withdrawn'.
create table if not exists stories (
  id                uuid primary key default gen_random_uuid(),
  author_id         uuid not null references users(id) on delete cascade,
  booking_id        uuid references bookings(id) on delete set null,
  listing_id        uuid references listings(id) on delete set null,
  event_id          uuid references events(id) on delete set null,
  town              text not null,
  title             text not null,
  body              text not null,
  media_urls        text[] not null default '{}',
  marketing_consent boolean not null default false,
  consent_at        timestamptz,
  status            text not null default 'pending'
                      check (status in ('pending', 'published', 'rejected', 'withdrawn')),
  published_at      timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists idx_stories_status on stories (status);
create index if not exists idx_stories_town on stories (town);
create index if not exists idx_stories_published_at on stories (published_at desc);
create index if not exists idx_stories_author on stories (author_id);

-- Opt-in "who is here" card. No row, or visible = false, means hidden.
create table if not exists guest_profiles (
  user_id      uuid primary key references users(id) on delete cascade,
  visible      boolean not null default false,
  headline     text,
  home_country text,
  work_status  text,
  updated_at   timestamptz not null default now()
);

create table if not exists meetups (
  id           uuid primary key default gen_random_uuid(),
  host_user_id uuid not null references users(id) on delete cascade,
  listing_id   uuid references listings(id) on delete set null,
  event_id     uuid references events(id) on delete set null,
  town         text not null,
  title        text not null,
  description  text not null default '',
  starts_at    timestamptz not null,
  place_text   text not null,
  capacity     integer check (capacity is null or capacity > 0),
  status       text not null default 'open' check (status in ('open', 'cancelled')),
  created_at   timestamptz not null default now()
);
create index if not exists idx_meetups_listing on meetups (listing_id);
create index if not exists idx_meetups_starts_at on meetups (starts_at);
create index if not exists idx_meetups_town on meetups (town);

create table if not exists meetup_members (
  meetup_id uuid not null references meetups(id) on delete cascade,
  user_id   uuid not null references users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (meetup_id, user_id)
);
create index if not exists idx_meetup_members_user on meetup_members (user_id);

-- One chat room per listing, open to guests with a confirmed/in-progress/
-- completed booking there.
create table if not exists stay_chat_messages (
  id         uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id) on delete cascade,
  sender_id  uuid not null references users(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists idx_stay_chat_listing_created
  on stay_chat_messages (listing_id, created_at desc);

create table if not exists user_blocks (
  blocker_id uuid not null references users(id) on delete cascade,
  blocked_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists idx_user_blocks_blocked on user_blocks (blocked_id);

create table if not exists reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references users(id) on delete cascade,
  target_type text not null check (target_type in ('user', 'story', 'message', 'meetup')),
  target_id   uuid not null,
  reason      text not null,
  status      text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at  timestamptz not null default now()
);
create index if not exists idx_reports_status on reports (status);

alter table events             enable row level security;
alter table stories            enable row level security;
alter table guest_profiles     enable row level security;
alter table meetups            enable row level security;
alter table meetup_members     enable row level security;
alter table stay_chat_messages enable row level security;
alter table user_blocks        enable row level security;
alter table reports            enable row level security;

commit;
