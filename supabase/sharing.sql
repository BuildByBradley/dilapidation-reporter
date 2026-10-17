-- Dilapidation Inspector — project sharing (rev 04). Run AFTER setup.sql:
-- SQL Editor → New query → paste all of this → Run. Safe to run again.
--
-- Model: a project's records are shared by its members. Roles: owner (creator), editor (can change), viewer (read only).
-- People join through invite links (a secret token sent by the owner), not by email address — email addresses are not
-- verified on this project, so they cannot prove who someone is.

-- 0. If the same project was uploaded from two accounts (e.g. signed in with different emails on phone and PC),
--    everyone keeps access — the account that worked on it last becomes owner, the others editors — and only the
--    newest copy of each record is kept.
alter table public.records replica identity full; -- lets duplicate rows be removed while the table broadcasts live changes
create table if not exists public.project_members (
  project_id text not null,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null check (role in ('owner', 'editor', 'viewer')),
  email      text,
  added_at   timestamptz not null default now(),
  primary key (project_id, user_id)
);
insert into public.project_members (project_id, user_id, role, email)
select x.project_id, x.owner, case when x.rn = 1 then 'owner' else 'editor' end, u.email
from (
  select project_id, owner, row_number() over (partition by project_id order by max(updated_at) desc, owner) as rn
  from public.records group by project_id, owner
) x
join auth.users u on u.id = x.owner
on conflict do nothing;
delete from public.records r using public.records newer
where r.kind = newer.kind and r.id = newer.id and r.owner <> newer.owner
  and (newer.updated_at > r.updated_at or (newer.updated_at = r.updated_at and newer.owner > r.owner));

-- 1. One row per record for everyone in the project (owner column now means "last written by").
alter table public.records drop constraint if exists records_pkey;
alter table public.records add primary key (kind, id);
alter table public.records replica identity default;
create index if not exists records_project on public.records (project_id);
create index if not exists records_updated on public.records (updated_at);

-- 2. Members and invites.
create table if not exists public.project_members (
  project_id text not null,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null check (role in ('owner', 'editor', 'viewer')),
  email      text,
  added_at   timestamptz not null default now(),
  primary key (project_id, user_id)
);
create table if not exists public.project_invites (
  token        text primary key default encode(extensions.gen_random_bytes(18), 'hex'),
  project_id   text not null,
  role         text not null check (role in ('editor', 'viewer')),
  project_name text,
  created_by   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '14 days',
  accepted_by  uuid references auth.users (id) on delete set null,
  accepted_at  timestamptz
);
create index if not exists project_invites_project on public.project_invites (project_id);

-- Everyone who already has projects becomes their owner.
insert into public.project_members (project_id, user_id, role, email)
select distinct on (r.project_id) r.project_id, r.owner, 'owner', u.email
from public.records r join auth.users u on u.id = r.owner
order by r.project_id, (r.kind = 'projects') desc, r.updated_at
on conflict do nothing;

-- 3. Access helpers (security definer: they read the membership table without recursing into its own policies).
create or replace function public.project_role(p text) returns text
language sql stable security definer set search_path = '' as $$
  select role from public.project_members where project_id = p and user_id = auth.uid()
$$;
create or replace function public.can_read(p text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.project_members where project_id = p and user_id = auth.uid())
$$;
create or replace function public.can_write(p text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.project_members where project_id = p and user_id = auth.uid() and role in ('owner', 'editor'))
$$;
-- A brand-new project nobody has claimed yet (its first upload makes the uploader the owner).
create or replace function public.is_unclaimed(p text) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.project_members where project_id = p)
$$;

-- The first device to upload a project's record becomes its owner.
create or replace function public.claim_project() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'projects' and not exists (select 1 from public.project_members where project_id = new.project_id) then
    insert into public.project_members (project_id, user_id, role, email)
    values (new.project_id, auth.uid(), 'owner', auth.jwt() ->> 'email');
  end if;
  return null;
end $$;
drop trigger if exists records_claim on public.records;
create trigger records_claim after insert on public.records for each row execute function public.claim_project();

-- 4. Records: members read; owners/editors write; only the owner can delete the project itself.
drop policy if exists "own records" on public.records;
drop policy if exists "members read" on public.records;
drop policy if exists "members insert" on public.records;
drop policy if exists "members update" on public.records;
create policy "members read" on public.records for select to authenticated
  using (public.can_read(project_id));
create policy "members insert" on public.records for insert to authenticated
  with check (public.can_write(project_id) or (kind = 'projects' and id = project_id and public.is_unclaimed(project_id)));
create policy "members update" on public.records for update to authenticated
  using (public.can_write(project_id))
  with check (public.can_write(project_id) and (kind <> 'projects' or not deleted or public.project_role(project_id) = 'owner'));

-- 5. Members: members see each other; the owner manages; anyone may leave (except the owner).
alter table public.project_members enable row level security;
drop policy if exists "see co-members" on public.project_members;
drop policy if exists "owner manages" on public.project_members;
drop policy if exists "owner updates" on public.project_members;
drop policy if exists "remove member or leave" on public.project_members;
create policy "see co-members" on public.project_members for select to authenticated using (public.can_read(project_id));
create policy "owner updates" on public.project_members for update to authenticated
  using (public.project_role(project_id) = 'owner' and role <> 'owner') with check (role in ('editor', 'viewer'));
create policy "remove member or leave" on public.project_members for delete to authenticated
  using (role <> 'owner' and (public.project_role(project_id) = 'owner' or user_id = auth.uid()));

-- 6. Invites: only the owner creates, sees and revokes them; joining goes through accept_invite().
alter table public.project_invites enable row level security;
drop policy if exists "owner invites" on public.project_invites;
create policy "owner invites" on public.project_invites for all to authenticated
  using (public.project_role(project_id) = 'owner')
  with check (public.project_role(project_id) = 'owner' and created_by = auth.uid());

create or replace function public.accept_invite(t text)
returns table (project_id text, role text, project_name text)
language plpgsql security definer set search_path = '' as $$
declare inv public.project_invites;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  select * into inv from public.project_invites i where i.token = t;
  if not found then raise exception 'This invite link is not valid (it may have been revoked).'; end if;
  if inv.accepted_by is not null and inv.accepted_by <> auth.uid() then raise exception 'This invite link has already been used.'; end if;
  if inv.expires_at < now() then raise exception 'This invite link has expired. Ask for a new one.'; end if;
  insert into public.project_members (project_id, user_id, role, email)
  values (inv.project_id, auth.uid(), inv.role, auth.jwt() ->> 'email')
  on conflict on constraint project_members_pkey do update set role = excluded.role
    where public.project_members.role <> 'owner';
  update public.project_invites set accepted_by = auth.uid(), accepted_at = now() where token = t;
  return query select inv.project_id, coalesce(public.project_role(inv.project_id), inv.role), inv.project_name;
end $$;
revoke all on function public.accept_invite(text) from public, anon;
grant execute on function public.accept_invite(text) to authenticated;

-- 7. Files: stored per project ("<projectId>/<fileId>"); members read, owners/editors write.
--    The old per-user folders stay readable by their owner while the app moves files over.
drop policy if exists "project blobs read" on storage.objects;
drop policy if exists "project blobs insert" on storage.objects;
drop policy if exists "project blobs update" on storage.objects;
drop policy if exists "project blobs delete" on storage.objects;
create policy "project blobs read" on storage.objects for select to authenticated
  using (bucket_id = 'blobs' and public.can_read((storage.foldername(name))[1]));
create policy "project blobs insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'blobs' and (public.can_write((storage.foldername(name))[1]) or public.is_unclaimed((storage.foldername(name))[1])));
create policy "project blobs update" on storage.objects for update to authenticated
  using (bucket_id = 'blobs' and (public.can_write((storage.foldername(name))[1]) or public.is_unclaimed((storage.foldername(name))[1])));
create policy "project blobs delete" on storage.objects for delete to authenticated
  using (bucket_id = 'blobs' and public.can_write((storage.foldername(name))[1]));

-- 8. Live updates for membership changes too.
do $$ begin
  alter publication supabase_realtime add table public.project_members;
exception when duplicate_object then null; end $$;
