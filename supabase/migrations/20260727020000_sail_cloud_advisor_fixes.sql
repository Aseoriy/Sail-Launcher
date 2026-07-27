create index if not exists storage_upload_reservations_user_idx
  on public.storage_upload_reservations(user_id);
create index if not exists storage_upload_reservations_artifact_idx
  on public.storage_upload_reservations(artifact_id)
  where artifact_id is not null;

drop policy if exists "Service role manages upload reservations"
on public.storage_upload_reservations;
create policy "Service role manages upload reservations"
on public.storage_upload_reservations for all to service_role
using (true)
with check (true);

alter policy "Authenticated users can upload items"
on public.items
with check ((select auth.uid()) = author_id);

alter policy "Authors and Admin can update items"
on public.items
using (
  (select auth.uid()) = author_id
  or exists (
    select 1 from public.profiles
    where profiles.id = (select auth.uid())
      and profiles.username = 'Aseoriy'
  )
)
with check (
  (select auth.uid()) = author_id
  or exists (
    select 1 from public.profiles
    where profiles.id = (select auth.uid())
      and profiles.username = 'Aseoriy'
  )
);

alter policy "Authors and Admin can delete items"
on public.items
using (
  (select auth.uid()) = author_id
  or exists (
    select 1 from public.profiles
    where profiles.id = (select auth.uid())
      and profiles.username = 'Aseoriy'
  )
);

create or replace function public.increment_downloads(item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.items
  set downloads = coalesce(downloads, 0) + 1
  where id = item_id;
end;
$$;
