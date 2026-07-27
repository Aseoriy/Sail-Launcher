-- Qualify sync-artifact columns that share names with the function's
-- RETURNS TABLE output variables. The unqualified revision reference caused
-- live account uploads to fail during commit after the R2 PUT had succeeded.
create or replace function public.commit_sail_account_upload(
  p_user_id uuid,
  p_reservation_id uuid,
  p_etag text
)
returns table (
  artifact_id uuid,
  revision bigint,
  object_key text,
  delete_keys text[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation public.storage_upload_reservations%rowtype;
  artifact public.sync_artifacts%rowtype;
  stale_keys text[];
begin
  select * into reservation
  from public.storage_upload_reservations
  where id = p_reservation_id and user_id = p_user_id and scope = 'account'
  for update;
  if reservation.id is null then raise exception using message = 'RESERVATION_NOT_FOUND'; end if;
  if reservation.status = 'committed' then
    return query
      select o.artifact_id, o.revision, o.object_key, array[]::text[]
      from public.sync_artifact_objects o
      where o.object_key = reservation.object_key;
    return;
  end if;
  if reservation.status <> 'reserved' or reservation.expires_at <= timezone('utc', now()) then
    raise exception using message = 'RESERVATION_EXPIRED';
  end if;

  select * into artifact from public.sync_artifacts
  where id = reservation.artifact_id for update;
  if artifact.revision <> reservation.expected_revision then
    raise exception using message = 'REVISION_CONFLICT';
  end if;

  insert into public.sync_artifact_objects (
    artifact_id, user_id, object_key, revision, size_bytes,
    content_type, sha256, etag
  ) values (
    artifact.id, p_user_id, reservation.object_key, reservation.next_revision,
    reservation.size_bytes, reservation.content_type, reservation.sha256, left(p_etag, 300)
  );

  update public.sync_artifacts as target
  set base_revision = target.revision,
      revision = reservation.next_revision,
      content_hash = reservation.sha256,
      remote_objects = jsonb_build_object(
        'provider', 'r2',
        'object_key', reservation.object_key,
        'size_bytes', reservation.size_bytes,
        'content_type', reservation.content_type,
        'sha256', reservation.sha256,
        'etag', left(p_etag, 300)
      ),
      updated_at = timezone('utc', now())
  where target.id = artifact.id;

  update public.storage_upload_reservations
  set status = 'committed', committed_at = timezone('utc', now())
  where id = reservation.id;

  with ranked as (
    select o.id, o.object_key,
      row_number() over (order by o.revision desc) as position
    from public.sync_artifact_objects as o
    where o.artifact_id = artifact.id and o.deleted_at is null
  ), stale as (
    update public.sync_artifact_objects as target
    set state = 'deleting'
    from ranked as r
    where target.id = r.id and r.position > reservation.max_versions
    returning target.object_key
  )
  select coalesce(array_agg(stale.object_key), array[]::text[]) into stale_keys
  from stale;

  return query select artifact.id, reservation.next_revision, reservation.object_key, stale_keys;
end;
$$;
