-- Dilapidation Inspector — cloud sync setup (rev 02).
-- Run once in Supabase: SQL Editor → New query → paste all of this → Run. Safe to run again.

-- 1. One table holds every synced record (projects, floors, findings, categories, photos, assets),
--    each owned by the signed-in user. Deletions are kept as tombstones so other devices learn about them.
create table if not exists public.records (
  owner      uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text        not null,
  id         text        not null,
  project_id text        not null,
  data       jsonb,
  deleted    boolean     not null default false,
  device     text,
  updated_at timestamptz not null default now(),
  primary key (owner, kind, id)
);
create index if not exists records_owner_updated on public.records (owner, updated_at);

-- Server clock decides updated_at, so devices with wrong clocks still sync in order.
create or replace function public.records_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists records_touch on public.records;
create trigger records_touch before insert or update on public.records
  for each row execute function public.records_touch();

-- 2. Row-level security: each user only ever sees and changes their own rows.
alter table public.records enable row level security;
drop policy if exists "own records" on public.records;
create policy "own records" on public.records for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

-- 3. Live updates: broadcast changes to the user's other devices.
do $$ begin
  alter publication supabase_realtime add table public.records;
exception when duplicate_object then null; end $$;

-- 4. Private storage bucket for plans and photos, one folder per user.
insert into storage.buckets (id, name, public) values ('blobs', 'blobs', false)
  on conflict (id) do nothing;
drop policy if exists "own blobs select" on storage.objects;
drop policy if exists "own blobs insert" on storage.objects;
drop policy if exists "own blobs update" on storage.objects;
drop policy if exists "own blobs delete" on storage.objects;
create policy "own blobs select" on storage.objects for select to authenticated
  using (bucket_id = 'blobs' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own blobs insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'blobs' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own blobs update" on storage.objects for update to authenticated
  using (bucket_id = 'blobs' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own blobs delete" on storage.objects for delete to authenticated
  using (bucket_id = 'blobs' and (storage.foldername(name))[1] = (select auth.uid())::text);
