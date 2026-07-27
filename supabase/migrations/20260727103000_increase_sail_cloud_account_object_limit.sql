-- Let one private account object use the full included quota. The quota check
-- below still prevents a user from reserving more than their account allows.
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
  if p_artifact_type not in (
    'launcher-config',
    'library',
    'preset',
    'theme',
    'game-save',
    'game-config'
  ) then
    raise exception using message = 'UNSUPPORTED_ARTIFACT_TYPE';
  end if;
  if p_size_bytes < 1 or p_size_bytes > 524288000 then
    raise exception using message = 'ACCOUNT_OBJECT_SIZE_LIMIT';
  end if;
  if p_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception using message = 'INVALID_SHA256';
  end if;
  if not exists (
    select 1
    from public.launcher_profiles as profiles
    where profiles.id = p_profile_id
      and profiles.user_id = p_user_id
  ) then
    raise exception using message = 'PROFILE_NOT_FOUND';
  end if;

  clean_key := left(btrim(p_logical_key), 300);
  if clean_key = '' then
    raise exception using message = 'INVALID_LOGICAL_KEY';
  end if;
  keep_count := case
    when p_artifact_type in ('launcher-config', 'game-save', 'game-config')
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

  select artifacts.* into target_artifact
  from public.sync_artifacts as artifacts
  where artifacts.profile_id = p_profile_id
    and artifacts.logical_key = clean_key
  for update;

  if target_artifact.user_id <> p_user_id
    or target_artifact.artifact_type <> p_artifact_type then
    raise exception using message = 'ARTIFACT_OWNERSHIP_MISMATCH';
  end if;
  if target_artifact.revision <> coalesce(p_expected_revision, 0) then
    raise exception using message = 'REVISION_CONFLICT';
  end if;

  select * into status_row
  from public.sail_storage_status(p_user_id);
  if status_row.used_bytes + status_row.reserved_bytes + p_size_bytes
    > status_row.quota_bytes then
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

  return query
    select reservation_uuid, target_artifact.id, object_key, next_rev, expiry;
end;
$$;

revoke all on function public.reserve_sail_account_upload(
  uuid, uuid, text, text, bigint, text, text, bigint, integer, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.reserve_sail_account_upload(
  uuid, uuid, text, text, bigint, text, text, bigint, integer, uuid, uuid, uuid
) to service_role;
