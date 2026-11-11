-- Rollbacks and re-updates published from the launcher's Dev Controls.
--   rollback: launchers on any of from_versions are offered target_version (an older or other published release),
--             and every launcher stops offering from_versions as an update.
--   reupdate: launchers on any of from_versions are offered to reinstall their own version (a fixed copy was
--             uploaded under the same tag).
-- Only launchers with this feature (6.0.0-beta.6 and later) read this table.

create table public.launcher_update_directives (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default timezone('utc', now()),
  kind text not null check (kind in ('rollback', 'reupdate')),
  from_versions text[] not null
    check (public.valid_version_alert_targets(from_versions)),
  target_version text
    check (target_version is null or public.valid_version_alert_targets(array[target_version])),
  notes text not null default '' check (char_length(notes) <= 131072),
  active boolean not null default true,
  check (
    (kind = 'rollback' and target_version is not null and not (target_version = any(from_versions)))
    or (kind = 'reupdate' and target_version is null)
  )
);

create index launcher_update_directives_active_created_at_idx
  on public.launcher_update_directives (created_at desc)
  where active = true;

alter table public.launcher_update_directives enable row level security;

revoke all on table public.launcher_update_directives from public, anon, authenticated;
grant select on table public.launcher_update_directives to anon, authenticated;
grant insert on table public.launcher_update_directives to authenticated;
-- Admins can only retract (or restore) a directive, never rewrite what it says.
grant update (active) on table public.launcher_update_directives to authenticated;

create policy "Active update directives are public"
on public.launcher_update_directives
for select
to anon, authenticated
using (
  active = true
  or coalesce((select auth.jwt()) -> 'app_metadata' ->> 'alert_admin', 'false') = 'true'
);

create policy "Alert admins can publish update directives"
on public.launcher_update_directives
for insert
to authenticated
with check (
  coalesce((select auth.jwt()) -> 'app_metadata' ->> 'alert_admin', 'false') = 'true'
);

create policy "Alert admins can retract update directives"
on public.launcher_update_directives
for update
to authenticated
using (
  coalesce((select auth.jwt()) -> 'app_metadata' ->> 'alert_admin', 'false') = 'true'
)
with check (
  coalesce((select auth.jwt()) -> 'app_metadata' ->> 'alert_admin', 'false') = 'true'
);
