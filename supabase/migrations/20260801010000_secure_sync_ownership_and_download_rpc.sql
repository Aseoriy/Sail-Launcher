-- Keep sync child rows inside the authenticated user's own profile tree.
drop policy if exists "Owners manage sync policies"
on public.sync_policies;

create policy "Owners manage sync policies"
on public.sync_policies for all to authenticated
using (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.launcher_profiles as profiles
    where profiles.id = profile_id
      and profiles.user_id = (select auth.uid())
  )
)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.launcher_profiles as profiles
    where profiles.id = profile_id
      and profiles.user_id = (select auth.uid())
  )
);

drop policy if exists "Owners manage sync artifacts"
on public.sync_artifacts;

create policy "Owners manage sync artifacts"
on public.sync_artifacts for all to authenticated
using (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.launcher_profiles as profiles
    where profiles.id = profile_id
      and profiles.user_id = (select auth.uid())
  )
  and (
    library_id is null
    or exists (
      select 1
      from public.launcher_libraries as libraries
      where libraries.id = library_id
        and libraries.profile_id = public.sync_artifacts.profile_id
        and libraries.user_id = (select auth.uid())
    )
  )
)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.launcher_profiles as profiles
    where profiles.id = profile_id
      and profiles.user_id = (select auth.uid())
  )
  and (
    library_id is null
    or exists (
      select 1
      from public.launcher_libraries as libraries
      where libraries.id = library_id
        and libraries.profile_id = public.sync_artifacts.profile_id
        and libraries.user_id = (select auth.uid())
    )
  )
);

-- The public catalog can still be viewed and downloaded, but its popularity
-- counter is no longer a public SECURITY DEFINER write. A signed-in user can
-- count each catalog item once; anonymous callers receive an authorization
-- error and cannot inflate arbitrary counters.
create table if not exists public.item_download_events (
  item_id uuid not null references public.items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (item_id, user_id)
);

alter table public.item_download_events enable row level security;

revoke all on table public.item_download_events from public, anon, authenticated;

create or replace function public.increment_downloads(item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  target_item_id uuid := item_id;
begin
  if caller_id is null then
    raise exception using errcode = '42501', message = 'AUTHENTICATION_REQUIRED';
  end if;

  if not exists (
    select 1
    from public.items as catalog_items
    where catalog_items.id = target_item_id
  ) then
    return;
  end if;

  insert into public.item_download_events (item_id, user_id)
  values (target_item_id, caller_id)
  on conflict (item_id, user_id) do nothing;

  if found then
    update public.items as catalog_items
    set downloads = coalesce(catalog_items.downloads, 0) + 1
    where catalog_items.id = target_item_id;
  end if;
end;
$$;

revoke execute on function public.increment_downloads(uuid) from public, anon;
grant execute on function public.increment_downloads(uuid) to authenticated;
