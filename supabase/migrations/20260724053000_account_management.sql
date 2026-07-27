alter table public.profiles
  drop constraint if exists profiles_username_format;

alter table public.profiles
  add constraint profiles_username_format
  check (
    char_length(btrim(username)) between 3 and 32
    and username ~ '^[A-Za-z0-9_.-]+$'
  );

revoke insert, update, delete, truncate, trigger, references
on table public.profiles
from anon;

revoke insert, update, delete, truncate, trigger, references
on table public.profiles
from authenticated;

grant select on table public.profiles to anon, authenticated;
grant update (avatar_url) on table public.profiles to authenticated;

drop policy if exists "Upload owners can delete files" on storage.objects;
drop policy if exists "Upload owners can delete previews" on storage.objects;

create policy "Upload owners can delete files"
on storage.objects for delete to authenticated
using (
  bucket_id = 'files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy "Upload owners can delete previews"
on storage.objects for delete to authenticated
using (
  bucket_id = 'previews'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
