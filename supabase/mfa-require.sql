-- Dilapidation Inspector — make two-factor compulsory on the server. Run AFTER mfa.sql.
-- From now on every signed-in session must have passed its 6-digit code (aal2) before it can read or write any data.
-- The app already makes people set up and use two-factor, so run this once the new app version is live and people
-- have been told. A person who has not set it up yet sees the set-up screen when they open the app; until they finish it,
-- nothing syncs. Safe to run again. To go back to optional, run mfa.sql again.
create or replace function public.mfa_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select (select auth.jwt() ->> 'aal') = 'aal2'
$$;
grant execute on function public.mfa_ok() to authenticated;
