-- Qualify hub asset columns that share names with the function's output columns.
create or replace function public.commit_sail_hub_upload(
  p_user_id uuid,
  p_reservation_id uuid,
  p_etag text
)
returns table (
  item_id uuid,
  kind text,
  public_url text,
  delete_keys text[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation public.storage_upload_reservations%rowtype;
  asset_version uuid;
  asset_url text;
  old_keys text[];
begin
  select reservations.* into reservation
  from public.storage_upload_reservations as reservations
  where reservations.id = p_reservation_id
    and reservations.user_id = p_user_id
    and reservations.scope = 'hub'
  for update;

  if reservation.id is null then
    raise exception using message = 'RESERVATION_NOT_FOUND';
  end if;

  if reservation.status = 'committed' then
    return query
      select assets.item_id, assets.kind, assets.public_url, array[]::text[]
      from public.hub_asset_objects as assets
      where assets.object_key = reservation.object_key;
    return;
  end if;

  if reservation.status <> 'reserved'
    or reservation.expires_at <= timezone('utc', now()) then
    raise exception using message = 'RESERVATION_EXPIRED';
  end if;

  if not exists (
    select 1
    from public.items as items
    where items.id = reservation.item_id
      and items.author_id = p_user_id
  ) then
    raise exception using message = 'ITEM_NOT_FOUND';
  end if;

  asset_version := split_part(reservation.object_key, '/', 5)::uuid;
  asset_url := 'https://assets.sailhub.fyi/' || reservation.object_key;

  select coalesce(array_agg(assets.object_key), array[]::text[])
  into old_keys
  from public.hub_asset_objects as assets
  where assets.item_id = reservation.item_id
    and assets.kind = reservation.asset_kind
    and assets.active
    and assets.deleted_at is null;

  update public.hub_asset_objects as assets
  set active = false
  where assets.item_id = reservation.item_id
    and assets.kind = reservation.asset_kind
    and assets.active;

  insert into public.hub_asset_objects (
    item_id, user_id, kind, version_id, object_key, public_url,
    size_bytes, content_type, sha256, etag
  ) values (
    reservation.item_id, p_user_id, reservation.asset_kind, asset_version,
    reservation.object_key, asset_url, reservation.size_bytes,
    reservation.content_type, reservation.sha256, left(p_etag, 300)
  );

  update public.storage_upload_reservations as reservations
  set status = 'committed',
      committed_at = timezone('utc', now())
  where reservations.id = reservation.id;

  return query
    select reservation.item_id, reservation.asset_kind, asset_url, old_keys;
end;
$$;

revoke all on function public.commit_sail_hub_upload(uuid, uuid, text)
from public, anon, authenticated;
grant execute on function public.commit_sail_hub_upload(uuid, uuid, text)
to service_role;
