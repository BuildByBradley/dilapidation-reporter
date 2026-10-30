-- Dilapidation Inspector — "Suggest an improvement" storage (rev 04). Run once in the SQL Editor; safe to run again.
-- Signed-in users can add feedback; nobody can read it through the app. Read it in Table Editor → feedback.
create table if not exists public.feedback (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id    uuid default auth.uid() references auth.users (id) on delete set null,
  email      text,
  kind       text not null default 'idea' check (kind in ('bug', 'idea', 'question')),
  message    text not null check (char_length(message) between 3 and 5000),
  page       text,
  done       boolean not null default false
);
alter table public.feedback enable row level security;
drop policy if exists "add own feedback" on public.feedback;
create policy "add own feedback" on public.feedback for insert to authenticated with check (user_id = (select auth.uid()));
