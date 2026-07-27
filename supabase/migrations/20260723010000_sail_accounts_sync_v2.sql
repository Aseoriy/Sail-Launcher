create extension if not exists pgcrypto;
create extension if not exists supabase_vault;

create table if not exists public.launcher_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  pin_salt text,
  pin_verifier text,
  conflict_mode text not null default 'prompt' check (conflict_mode in ('prompt', 'newest', 'local')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, name)
);

create table if not exists public.launcher_libraries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id uuid not null references public.launcher_profiles(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  catalog jsonb not null default '{"games":[],"sections":[]}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (profile_id, name)
);

create table if not exists public.launcher_presets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id uuid not null references public.launcher_profiles(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (profile_id, name)
);

create table if not exists public.sync_policies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id uuid not null references public.launcher_profiles(id) on delete cascade,
  category text not null check (category in ('config', 'library', 'saves', 'game_configs')),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (profile_id, category)
);

create table if not exists public.sync_artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id uuid not null references public.launcher_profiles(id) on delete cascade,
  library_id uuid references public.launcher_libraries(id) on delete cascade,
  game_id uuid,
  config_entry_id uuid,
  artifact_type text not null check (artifact_type in ('launcher-config', 'library', 'theme', 'game-save', 'game-config')),
  logical_key text not null,
  content_hash text,
  base_revision bigint not null default 0,
  revision bigint not null default 0,
  writer_device uuid,
  remote_objects jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (profile_id, logical_key)
);

create table if not exists public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id uuid references public.launcher_profiles(id) on delete cascade,
  artifact_id uuid references public.sync_artifacts(id) on delete set null,
  trigger text not null,
  direction text not null check (direction in ('upload', 'download', 'compare')),
  status text not null check (status in ('queued', 'running', 'partial', 'completed', 'failed', 'skipped', 'conflict')),
  provider_results jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz
);

create table if not exists public.cloud_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google', 'dropbox', 'onedrive', 'mediafire')),
  provider_account_label text,
  status text not null default 'connected' check (status in ('connected', 'expired', 'revoked', 'error')),
  vault_secret_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  last_verified_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, provider)
);

create table if not exists public.oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google', 'dropbox')),
  nonce_hash text not null,
  consumed boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists launcher_profiles_user_idx on public.launcher_profiles(user_id);
create index if not exists launcher_libraries_profile_idx on public.launcher_libraries(profile_id);
create index if not exists launcher_presets_profile_idx on public.launcher_presets(profile_id);
create index if not exists sync_artifacts_profile_updated_idx on public.sync_artifacts(profile_id, updated_at desc);
create index if not exists sync_runs_user_created_idx on public.sync_runs(user_id, created_at desc);
create index if not exists oauth_states_expiry_idx on public.oauth_states(expires_at) where consumed = false;
create unique index if not exists profiles_username_lower_key on public.profiles(lower(username));

alter table public.launcher_profiles enable row level security;
alter table public.launcher_libraries enable row level security;
alter table public.launcher_presets enable row level security;
alter table public.sync_policies enable row level security;
alter table public.sync_artifacts enable row level security;
alter table public.sync_runs enable row level security;
alter table public.cloud_connections enable row level security;
alter table public.oauth_states enable row level security;

revoke all on table
  public.launcher_profiles,
  public.launcher_libraries,
  public.launcher_presets,
  public.sync_policies,
  public.sync_artifacts,
  public.sync_runs,
  public.cloud_connections,
  public.oauth_states
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.launcher_profiles,
  public.launcher_libraries,
  public.launcher_presets,
  public.sync_policies,
  public.sync_artifacts,
  public.sync_runs
to authenticated;

grant select (id, provider, provider_account_label, status, last_verified_at, created_at, updated_at)
on public.cloud_connections to authenticated;

create policy "Owners manage launcher profiles"
on public.launcher_profiles for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Owners manage launcher libraries"
on public.launcher_libraries for all to authenticated
using (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.launcher_profiles p
    where p.id = profile_id and p.user_id = (select auth.uid())
  )
)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.launcher_profiles p
    where p.id = profile_id and p.user_id = (select auth.uid())
  )
);

create policy "Owners manage launcher presets"
on public.launcher_presets for all to authenticated
using (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.launcher_profiles p
    where p.id = profile_id and p.user_id = (select auth.uid())
  )
)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.launcher_profiles p
    where p.id = profile_id and p.user_id = (select auth.uid())
  )
);

create policy "Owners manage sync policies"
on public.sync_policies for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Owners manage sync artifacts"
on public.sync_artifacts for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Owners manage sync runs"
on public.sync_runs for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Owners view cloud connection status"
on public.cloud_connections for select to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.store_cloud_connection_secret(
  p_user_id uuid,
  p_provider text,
  p_label text,
  p_secret jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  connection_id uuid;
  secret_id uuid;
begin
  if p_provider not in ('google', 'dropbox', 'onedrive', 'mediafire') then
    raise exception 'Unsupported cloud provider';
  end if;

  select id, vault_secret_id into connection_id, secret_id
  from public.cloud_connections
  where user_id = p_user_id and provider = p_provider;

  if connection_id is null then
    connection_id := gen_random_uuid();
    secret_id := vault.create_secret(
      p_secret::text,
      'sail-cloud-' || connection_id::text,
      'Sail Launcher cloud connection'
    );
    insert into public.cloud_connections (
      id, user_id, provider, provider_account_label, vault_secret_id, metadata, last_verified_at
    ) values (
      connection_id, p_user_id, p_provider, p_label, secret_id, coalesce(p_metadata, '{}'::jsonb), timezone('utc', now())
    );
  else
    perform vault.update_secret(secret_id, p_secret::text);
    update public.cloud_connections
    set provider_account_label = p_label,
        metadata = coalesce(p_metadata, '{}'::jsonb),
        status = 'connected',
        last_verified_at = timezone('utc', now()),
        updated_at = timezone('utc', now())
    where id = connection_id;
  end if;
  return connection_id;
end;
$$;

create or replace function public.read_cloud_connection_secret(p_user_id uuid, p_connection_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret::jsonb
  from vault.decrypted_secrets s
  join public.cloud_connections c on c.vault_secret_id = s.id
  where c.id = p_connection_id and c.user_id = p_user_id
$$;

create or replace function public.delete_cloud_connection_secret(p_user_id uuid, p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret_id uuid;
begin
  select vault_secret_id into secret_id
  from public.cloud_connections
  where id = p_connection_id and user_id = p_user_id;
  delete from public.cloud_connections where id = p_connection_id and user_id = p_user_id;
  if secret_id is not null then
    delete from vault.secrets where id = secret_id;
  end if;
end;
$$;

revoke all on function public.store_cloud_connection_secret(uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.read_cloud_connection_secret(uuid, uuid) from public, anon, authenticated;
revoke all on function public.delete_cloud_connection_secret(uuid, uuid) from public, anon, authenticated;
grant execute on function public.store_cloud_connection_secret(uuid, text, text, jsonb, jsonb) to service_role;
grant execute on function public.read_cloud_connection_secret(uuid, uuid) to service_role;
grant execute on function public.delete_cloud_connection_secret(uuid, uuid) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Avatar owners can read their object" on storage.objects;
drop policy if exists "Avatar owners can upload their object" on storage.objects;
drop policy if exists "Avatar owners can update their object" on storage.objects;
drop policy if exists "Avatar owners can delete their object" on storage.objects;

create policy "Avatar owners can read their object"
on storage.objects for select to authenticated
using (bucket_id = 'avatars' and owner_id = (select auth.uid())::text);

create policy "Avatar owners can upload their object"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.filename(name) ~ '^avatar\.(png|jpg|webp)$')
);

create policy "Avatar owners can update their object"
on storage.objects for update to authenticated
using (bucket_id = 'avatars' and owner_id = (select auth.uid())::text)
with check (
  bucket_id = 'avatars'
  and owner_id = (select auth.uid())::text
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy "Avatar owners can delete their object"
on storage.objects for delete to authenticated
using (bucket_id = 'avatars' and owner_id = (select auth.uid())::text);

alter table public.profiles drop column if exists email;

drop policy if exists "Public profiles are viewable by everyone" on public.profiles;
drop policy if exists "Users can insert their own profile" on public.profiles;
drop policy if exists "Users can update their own profile" on public.profiles;

create policy "Public profile identity is viewable"
on public.profiles for select to anon, authenticated
using (true);

create policy "Users insert their own profile"
on public.profiles for insert to authenticated
with check ((select auth.uid()) = id);

create policy "Users update their own profile"
on public.profiles for update to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, coalesce(nullif(btrim(new.raw_user_meta_data ->> 'username'), ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;
