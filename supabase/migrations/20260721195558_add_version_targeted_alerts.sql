create or replace function public.valid_version_alert_targets(targets text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    cardinality(targets) > 0
    and cardinality(targets) = count(distinct version)
    and bool_and(
      case
        when version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$'
        then row(
          split_part(split_part(version, '-', 1), '.', 1)::integer,
          split_part(split_part(version, '-', 1), '.', 2)::integer,
          split_part(split_part(version, '-', 1), '.', 3)::integer
        ) >= row(5, 2, 1)
        else false
      end
    )
  from unnest(targets) as version
$$;

revoke all on function public.valid_version_alert_targets(text[]) from public, anon, authenticated;
grant execute on function public.valid_version_alert_targets(text[]) to authenticated;

create table public.version_alerts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default timezone('utc', now()),
  message text not null check (char_length(btrim(message)) > 0),
  type text not null default 'info' check (type in ('info', 'warning', 'critical')),
  action_text text,
  action_url text check (action_url is null or action_url ~* '^https?://'),
  active boolean not null default true,
  target_versions text[] not null
    check (public.valid_version_alert_targets(target_versions))
);

create index version_alerts_active_created_at_idx
  on public.version_alerts (created_at desc)
  where active = true;

create index version_alerts_target_versions_idx
  on public.version_alerts using gin (target_versions);

alter table public.version_alerts enable row level security;

revoke all on table public.version_alerts from public, anon, authenticated;
grant select on table public.version_alerts to anon, authenticated;
grant insert on table public.version_alerts to authenticated;

create policy "Active version alerts are public"
on public.version_alerts
for select
to anon, authenticated
using (active = true);

create policy "Alert admins can publish version alerts"
on public.version_alerts
for insert
to authenticated
with check (
  coalesce((select auth.jwt()) -> 'app_metadata' ->> 'alert_admin', 'false') = 'true'
);

revoke all on table public.alerts from anon, authenticated;
grant select on table public.alerts to anon, authenticated;
grant insert on table public.alerts to authenticated;

revoke all on sequence public.alerts_id_seq from anon, authenticated;
grant usage, select on sequence public.alerts_id_seq to authenticated;

drop policy if exists "Allow public read access to active alerts" on public.alerts;
drop policy if exists "Active global alerts are public" on public.alerts;
drop policy if exists "Alert admins can publish global alerts" on public.alerts;

create policy "Active global alerts are public"
on public.alerts
for select
to anon, authenticated
using (active = true);

create policy "Alert admins can publish global alerts"
on public.alerts
for insert
to authenticated
with check (
  coalesce((select auth.jwt()) -> 'app_metadata' ->> 'alert_admin', 'false') = 'true'
);
