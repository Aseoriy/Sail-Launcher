-- Sail Cloud control plane for private account sync and public Sail Hub assets.
-- Object bytes live in Cloudflare R2; Postgres remains the authority for
-- ownership, quotas, revisions, reservations, and public item metadata.

alter table public.sync_artifacts
  drop constraint if exists sync_artifacts_artifact_type_check;

alter table public.sync_artifacts
  add constraint sync_artifacts_artifact_type_check
  check (artifact_type in (
    'launcher-config',
    'library',
    'preset',
    'theme',
    'game-save',
    'game-config'
  ));

create table if not exists public.account_storage_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'included'
    check (plan in ('included', 'plus')),
  quota_bytes bigint not null default 524288000
    check (quota_bytes between 0 and 1073741824),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.sync_artifact_objects (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.sync_artifacts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  object_key text not null unique,
  revision bigint not null check (revision > 0),
  size_bytes bigint not null check (size_bytes >= 0),
  content_type text not null,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  etag text,
  state text not null default 'active'
    check (state in ('active', 'superseded', 'deleting')),
  created_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  unique (artifact_id, revision)
);

create table if not exists public.storage_upload_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null check (scope in ('account', 'hub')),
  artifact_id uuid references public.sync_artifacts(id) on delete cascade,
  item_id uuid,
  asset_kind text check (asset_kind in ('package', 'preview')),
  object_key text not null unique,
  expected_revision bigint,
  next_revision bigint,
  max_versions integer not null default 1 check (max_versions between 1 and 5),
  size_bytes bigint not null check (size_bytes >= 0),
  content_type text not null,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'reserved'
    check (status in ('reserved', 'committed', 'cancelled', 'expired')),
  created_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null default (timezone('utc', now()) + interval '1 hour'),
  committed_at timestamptz
);

create table if not exists public.hub_asset_objects (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('package', 'preview')),
  version_id uuid not null,
  object_key text not null unique,
  public_url text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  content_type text not null,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  etag text,
  active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz
);

create index if not exists sync_artifact_objects_user_active_idx
  on public.sync_artifact_objects(user_id, created_at desc)
  where deleted_at is null;
create index if not exists sync_artifact_objects_artifact_versions_idx
  on public.sync_artifact_objects(artifact_id, revision desc)
  where deleted_at is null;
create index if not exists storage_upload_reservations_expiry_idx
  on public.storage_upload_reservations(expires_at)
  where status = 'reserved';
create index if not exists hub_asset_objects_item_kind_idx
  on public.hub_asset_objects(item_id, kind, created_at desc)
  where deleted_at is null;
create index if not exists hub_asset_objects_user_idx
  on public.hub_asset_objects(user_id, created_at desc)
  where deleted_at is null;

alter table public.account_storage_entitlements enable row level security;
alter table public.sync_artifact_objects enable row level security;
alter table public.storage_upload_reservations enable row level security;
alter table public.hub_asset_objects enable row level security;

revoke all on table
  public.account_storage_entitlements,
  public.sync_artifact_objects,
  public.storage_upload_reservations,
  public.hub_asset_objects
from public, anon, authenticated;

grant select on table
  public.account_storage_entitlements,
  public.sync_artifact_objects
to authenticated;

grant select on table public.hub_asset_objects to anon, authenticated;

create policy "Owners view their storage entitlement"
on public.account_storage_entitlements for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Owners view their sync object versions"
on public.sync_artifact_objects for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Public views active Sail Hub assets"
on public.hub_asset_objects for select to anon, authenticated
using (active and deleted_at is null);

create or replace function public.sail_storage_status(p_user_id uuid)
returns table (
  plan text,
  quota_bytes bigint,
  used_bytes bigint,
  reserved_bytes bigint,
  remaining_bytes bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  entitlement public.account_storage_entitlements%rowtype;
  used bigint;
  reserved bigint;
begin
  insert into public.account_storage_entitlements(user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select * into entitlement
  from public.account_storage_entitlements
  where user_id = p_user_id;

  select coalesce(sum(size_bytes), 0) into used
  from public.sync_artifact_objects
  where user_id = p_user_id and deleted_at is null;

  select coalesce(sum(size_bytes), 0) into reserved
  from public.storage_upload_reservations
  where user_id = p_user_id
    and scope = 'account'
    and status = 'reserved'
    and expires_at > timezone('utc', now());

  return query select
    entitlement.plan,
    entitlement.quota_bytes,
    used,
    reserved,
    greatest(entitlement.quota_bytes - used - reserved, 0);
end;
$$;

create or replace function public.reserve_sail_account_upload(
  p_user_id uuid,
  p_profile_id uuid,
  p_artifact_type text,
  p_logical_key text,
  p_size_bytes bigint,
  p_content_type text,
  p_sha256 text,
  p_expected_revision bigint default 0,
  p_max_versions integer default 1,
  p_library_id uuid default null,
  p_game_id uuid default null,
  p_config_entry_id uuid default null
)
returns table (
  reservation_id uuid,
  artifact_id uuid,
  object_key text,
  revision bigint,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_artifact public.sync_artifacts%rowtype;
  reservation_uuid uuid := gen_random_uuid();
  next_rev bigint;
  expiry timestamptz := timezone('utc', now()) + interval '1 hour';
  status_row record;
  keep_count integer;
  clean_key text;
begin
  if p_artifact_type not in ('launcher-config', 'library', 'preset', 'theme', 'game-config') then
    raise exception using message = 'UNSUPPORTED_ARTIFACT_TYPE';
  end if;
  if p_size_bytes < 1 or p_size_bytes > 94371840 then
    raise exception using message = 'ACCOUNT_OBJECT_SIZE_LIMIT';
  end if;
  if p_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception using message = 'INVALID_SHA256';
  end if;
  if not exists (
    select 1 from public.launcher_profiles
    where id = p_profile_id and user_id = p_user_id
  ) then
    raise exception using message = 'PROFILE_NOT_FOUND';
  end if;

  clean_key := left(btrim(p_logical_key), 300);
  if clean_key = '' then raise exception using message = 'INVALID_LOGICAL_KEY'; end if;
  keep_count := case
    when p_artifact_type in ('launcher-config', 'game-config')
      then greatest(1, least(coalesce(p_max_versions, 1), 5))
    else 1
  end;

  insert into public.sync_artifacts (
    user_id, profile_id, library_id, game_id, config_entry_id,
    artifact_type, logical_key
  ) values (
    p_user_id, p_profile_id, p_library_id, p_game_id, p_config_entry_id,
    p_artifact_type, clean_key
  )
  on conflict (profile_id, logical_key) do nothing;

  select * into target_artifact
  from public.sync_artifacts
  where profile_id = p_profile_id and logical_key = clean_key
  for update;

  if target_artifact.user_id <> p_user_id or target_artifact.artifact_type <> p_artifact_type then
    raise exception using message = 'ARTIFACT_OWNERSHIP_MISMATCH';
  end if;
  if target_artifact.revision <> coalesce(p_expected_revision, 0) then
    raise exception using message = 'REVISION_CONFLICT';
  end if;

  select * into status_row from public.sail_storage_status(p_user_id);
  if status_row.used_bytes + status_row.reserved_bytes + p_size_bytes > status_row.quota_bytes then
    raise exception using message = 'ACCOUNT_QUOTA_EXCEEDED';
  end if;

  next_rev := target_artifact.revision + 1;
  object_key := 'users/' || p_user_id::text || '/' || p_artifact_type || '/'
    || target_artifact.id::text || '/' || lpad(next_rev::text, 12, '0')
    || '-' || reservation_uuid::text || '.bin';

  insert into public.storage_upload_reservations (
    id, user_id, scope, artifact_id, object_key, expected_revision,
    next_revision, max_versions, size_bytes, content_type, sha256, expires_at
  ) values (
    reservation_uuid, p_user_id, 'account', target_artifact.id, object_key,
    target_artifact.revision, next_rev, keep_count, p_size_bytes,
    left(p_content_type, 200), p_sha256, expiry
  );

  return query select reservation_uuid, target_artifact.id, object_key, next_rev, expiry;
end;
$$;

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

  update public.sync_artifacts
  set base_revision = revision,
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
  where id = artifact.id;

  update public.storage_upload_reservations
  set status = 'committed', committed_at = timezone('utc', now())
  where id = reservation.id;

  with ranked as (
    select id, object_key,
      row_number() over (order by revision desc) as position
    from public.sync_artifact_objects
    where artifact_id = artifact.id and deleted_at is null
  ), stale as (
    update public.sync_artifact_objects o
    set state = 'deleting'
    from ranked r
    where o.id = r.id and r.position > reservation.max_versions
    returning o.object_key
  )
  select coalesce(array_agg(stale.object_key), array[]::text[]) into stale_keys
  from stale;

  return query select artifact.id, reservation.next_revision, reservation.object_key, stale_keys;
end;
$$;

create or replace function public.cancel_sail_upload(
  p_user_id uuid,
  p_reservation_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_key text;
begin
  update public.storage_upload_reservations
  set status = 'cancelled'
  where id = p_reservation_id
    and user_id = p_user_id
    and status = 'reserved'
  returning object_key into target_key;
  return target_key;
end;
$$;

create or replace function public.mark_sail_objects_deleted(
  p_user_id uuid,
  p_object_keys text[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.sync_artifact_objects
  set deleted_at = timezone('utc', now())
  where user_id = p_user_id
    and object_key = any(coalesce(p_object_keys, array[]::text[]))
    and state = 'deleting'
    and deleted_at is null;
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.reserve_sail_hub_upload(
  p_user_id uuid,
  p_item_id uuid,
  p_kind text,
  p_size_bytes bigint,
  p_content_type text,
  p_sha256 text,
  p_extension text
)
returns table (
  reservation_id uuid,
  object_key text,
  public_url text,
  version_id uuid,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation_uuid uuid := gen_random_uuid();
  asset_version uuid := gen_random_uuid();
  expiry timestamptz := timezone('utc', now()) + interval '1 hour';
  normalized_extension text;
begin
  if p_kind not in ('package', 'preview') then raise exception using message = 'INVALID_ASSET_KIND'; end if;
  if p_kind = 'package' and (p_size_bytes < 1 or p_size_bytes > 104857600) then
    raise exception using message = 'PACKAGE_SIZE_LIMIT';
  end if;
  if p_kind = 'preview' and (p_size_bytes < 1 or p_size_bytes > 5242880) then
    raise exception using message = 'PREVIEW_SIZE_LIMIT';
  end if;
  if p_sha256 !~ '^[a-f0-9]{64}$' then raise exception using message = 'INVALID_SHA256'; end if;
  if exists (select 1 from public.items where id = p_item_id and author_id <> p_user_id) then
    raise exception using message = 'ITEM_OWNERSHIP_MISMATCH';
  end if;

  normalized_extension := lower(regexp_replace(coalesce(p_extension, ''), '[^a-z0-9]', '', 'g'));
  if p_kind = 'package' and normalized_extension not in ('json', 'zip', 'rar', '7z') then
    raise exception using message = 'INVALID_PACKAGE_TYPE';
  end if;
  if p_kind = 'preview' and normalized_extension not in ('png', 'jpg', 'jpeg', 'webp') then
    raise exception using message = 'INVALID_PREVIEW_TYPE';
  end if;

  object_key := 'authors/' || p_user_id::text || '/items/' || p_item_id::text
    || '/' || asset_version::text || '/' || p_kind || '.' || normalized_extension;
  public_url := 'https://assets.sailhub.fyi/' || object_key;

  insert into public.storage_upload_reservations (
    id, user_id, scope, item_id, asset_kind, object_key, size_bytes,
    content_type, sha256, expires_at
  ) values (
    reservation_uuid, p_user_id, 'hub', p_item_id, p_kind, object_key,
    p_size_bytes, left(p_content_type, 200), p_sha256, expiry
  );

  return query select reservation_uuid, object_key, public_url, asset_version, expiry;
end;
$$;

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
  select * into reservation
  from public.storage_upload_reservations
  where id = p_reservation_id and user_id = p_user_id and scope = 'hub'
  for update;
  if reservation.id is null then raise exception using message = 'RESERVATION_NOT_FOUND'; end if;
  if reservation.status = 'committed' then
    return query
      select h.item_id, h.kind, h.public_url, array[]::text[]
      from public.hub_asset_objects h
      where h.object_key = reservation.object_key;
    return;
  end if;
  if reservation.status <> 'reserved' or reservation.expires_at <= timezone('utc', now()) then
    raise exception using message = 'RESERVATION_EXPIRED';
  end if;
  if not exists (
    select 1 from public.items
    where id = reservation.item_id and author_id = p_user_id
  ) then raise exception using message = 'ITEM_NOT_FOUND'; end if;

  asset_version := split_part(reservation.object_key, '/', 5)::uuid;
  asset_url := 'https://assets.sailhub.fyi/' || reservation.object_key;

  select coalesce(array_agg(object_key), array[]::text[]) into old_keys
  from public.hub_asset_objects
  where item_id = reservation.item_id
    and kind = reservation.asset_kind
    and active
    and deleted_at is null;

  update public.hub_asset_objects
  set active = false
  where item_id = reservation.item_id and kind = reservation.asset_kind and active;

  insert into public.hub_asset_objects (
    item_id, user_id, kind, version_id, object_key, public_url,
    size_bytes, content_type, sha256, etag
  ) values (
    reservation.item_id, p_user_id, reservation.asset_kind, asset_version,
    reservation.object_key, asset_url, reservation.size_bytes,
    reservation.content_type, reservation.sha256, left(p_etag, 300)
  );

  update public.storage_upload_reservations
  set status = 'committed', committed_at = timezone('utc', now())
  where id = reservation.id;

  return query select reservation.item_id, reservation.asset_kind, asset_url, old_keys;
end;
$$;

create or replace function public.mark_sail_hub_objects_deleted(
  p_user_id uuid,
  p_object_keys text[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.hub_asset_objects
  set deleted_at = timezone('utc', now())
  where user_id = p_user_id
    and object_key = any(coalesce(p_object_keys, array[]::text[]))
    and not active
    and deleted_at is null;
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.expire_sail_upload_reservations()
returns table (scope text, object_key text)
language sql
security definer
set search_path = ''
as $$
  update public.storage_upload_reservations r
  set status = 'expired'
  where r.status = 'reserved'
    and r.expires_at <= timezone('utc', now()) - interval '23 hours'
  returning r.scope, r.object_key
$$;

revoke all on function public.sail_storage_status(uuid) from public, anon, authenticated;
revoke all on function public.reserve_sail_account_upload(uuid, uuid, text, text, bigint, text, text, bigint, integer, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.commit_sail_account_upload(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.cancel_sail_upload(uuid, uuid) from public, anon, authenticated;
revoke all on function public.mark_sail_objects_deleted(uuid, text[]) from public, anon, authenticated;
revoke all on function public.reserve_sail_hub_upload(uuid, uuid, text, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.commit_sail_hub_upload(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.mark_sail_hub_objects_deleted(uuid, text[]) from public, anon, authenticated;
revoke all on function public.expire_sail_upload_reservations() from public, anon, authenticated;

grant execute on function public.sail_storage_status(uuid) to service_role;
grant execute on function public.reserve_sail_account_upload(uuid, uuid, text, text, bigint, text, text, bigint, integer, uuid, uuid, uuid) to service_role;
grant execute on function public.commit_sail_account_upload(uuid, uuid, text) to service_role;
grant execute on function public.cancel_sail_upload(uuid, uuid) to service_role;
grant execute on function public.mark_sail_objects_deleted(uuid, text[]) to service_role;
grant execute on function public.reserve_sail_hub_upload(uuid, uuid, text, bigint, text, text, text) to service_role;
grant execute on function public.commit_sail_hub_upload(uuid, uuid, text) to service_role;
grant execute on function public.mark_sail_hub_objects_deleted(uuid, text[]) to service_role;
grant execute on function public.expire_sail_upload_reservations() to service_role;

-- Supabase public URLs do not need broad SELECT policies. Keep the legacy
-- buckets readable by URL during the migration rollback window without
-- allowing anonymous bucket enumeration.
drop policy if exists "Anyone can view files" on storage.objects;
drop policy if exists "Anyone can view previews" on storage.objects;
