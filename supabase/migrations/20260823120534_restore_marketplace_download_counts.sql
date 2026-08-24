drop function if exists public.increment_downloads(uuid);
drop function if exists private.increment_downloads(uuid);

create function private.increment_downloads(item_id uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  updated_count integer;
begin
  if not exists (
    select 1
    from public.items as catalog_items
    where catalog_items.id = item_id
  ) then
    return null;
  end if;

  if caller_id is not null then
    insert into public.item_download_events (item_id, user_id)
    values (item_id, caller_id)
    on conflict on constraint item_download_events_pkey do nothing;

    if not found then
      select catalog_items.downloads
      into updated_count
      from public.items as catalog_items
      where catalog_items.id = item_id;
      return updated_count;
    end if;
  end if;

  update public.items as catalog_items
  set downloads = least(coalesce(catalog_items.downloads, 0)::bigint + 1, 2147483647)::integer
  where catalog_items.id = item_id
  returning catalog_items.downloads into updated_count;

  return updated_count;
end;
$$;

revoke all on function private.increment_downloads(uuid) from public, anon, authenticated, service_role;

create function public.increment_downloads(item_id uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  select private.increment_downloads(item_id);
$$;

revoke all on function public.increment_downloads(uuid) from public, anon, authenticated, service_role;
grant execute on function public.increment_downloads(uuid) to anon, authenticated, service_role;
