-- Dilapidation Inspector — two-factor sign-in rules. Run AFTER setup.sql and sharing.sql:
-- SQL Editor → New query → paste all of this → Run. Safe to run again.
--
-- Before running: Supabase dashboard → Authentication → (Sign In / Providers or Multi-Factor) → turn ON "TOTP" (authenticator app) MFA.
--
-- What it does: an account that has switched on two-factor (enrolled an authenticator app) can only read or write data
-- from a session that has entered its 6-digit code (assurance level aal2). A stolen password alone then gets nothing.
-- Accounts that have NOT enrolled keep working as before, so nobody is locked out when this is run.
-- To require two-factor for EVERYONE, change mfa_ok() as shown in the comment below, once every user has enrolled.

create or replace function public.mfa_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when (select auth.jwt() ->> 'aal') = 'aal2' then true
    -- aal1 session: allowed only if this account has no verified authenticator
    else not exists (select 1 from auth.mfa_factors f where f.user_id = (select auth.uid()) and f.status = 'verified')
  end
$$;
-- Require two-factor for everyone (run only after all users have enrolled):
--   create or replace function public.mfa_ok() returns boolean
--   language sql stable security definer set search_path = '' as $$ select (select auth.jwt() ->> 'aal') = 'aal2' $$;
grant execute on function public.mfa_ok() to authenticated;

-- RESTRICTIVE policies are ANDed with the existing ones: they can only take access away, never add it.
drop policy if exists "mfa records" on public.records;
create policy "mfa records" on public.records as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());

drop policy if exists "mfa members" on public.project_members;
create policy "mfa members" on public.project_members as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());

drop policy if exists "mfa invites" on public.project_invites;
create policy "mfa invites" on public.project_invites as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());

drop policy if exists "mfa feedback" on public.feedback;
create policy "mfa feedback" on public.feedback as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());

drop policy if exists "mfa blobs" on storage.objects;
create policy "mfa blobs" on storage.objects as restrictive for all to authenticated
  using (bucket_id <> 'blobs' or public.mfa_ok()) with check (bucket_id <> 'blobs' or public.mfa_ok());

-- accept_invite() runs as the table owner and so skips the policies above; make it check explicitly.
create or replace function public.accept_invite(t text)
returns table (project_id text, role text, project_name text)
language plpgsql security definer set search_path = '' as $$
declare inv public.project_invites;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not public.mfa_ok() then raise exception 'Enter your two-factor code first.'; end if;
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
