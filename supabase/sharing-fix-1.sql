-- Fix for sharing.sql (rev 04): let a brand-new project's first upload through.
-- "Insert or update" uploads also require read access to the new row/file; a project nobody has claimed yet had none.
drop policy if exists "members read" on public.records;
create policy "members read" on public.records for select to authenticated
  using (public.can_read(project_id) or (kind = 'projects' and id = project_id and public.is_unclaimed(project_id)));
drop policy if exists "project blobs read" on storage.objects;
create policy "project blobs read" on storage.objects for select to authenticated
  using (bucket_id = 'blobs' and (public.can_read((storage.foldername(name))[1]) or owner_id = (select auth.uid())::text));
