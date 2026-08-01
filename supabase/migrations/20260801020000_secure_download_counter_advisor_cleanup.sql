-- Make the deny-by-default event table explicit and index its user foreign key.
drop policy if exists "No direct access to download events" on public.item_download_events;

create policy "No direct access to download events"
on public.item_download_events
for all
to anon, authenticated
using (false)
with check (false);

create index if not exists item_download_events_user_idx
  on public.item_download_events(user_id);

-- Keep the public RPC signature for existing website callers, but keep
-- privileged work in a private, non-REST-exposed schema.
create schema if not exists private;

create or replace function private.increment_downloads(item_id uuid)
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

revoke execute on function private.increment_downloads(uuid) from public, anon;
grant execute on function private.increment_downloads(uuid) to authenticated;

create or replace function public.increment_downloads(item_id uuid)
returns void
language sql
security invoker
set search_path = public
as $$
  select private.increment_downloads(item_id);
$$;

revoke execute on function public.increment_downloads(uuid) from public, anon;
grant execute on function public.increment_downloads(uuid) to authenticated;
