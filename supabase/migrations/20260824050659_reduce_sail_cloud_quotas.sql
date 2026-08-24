-- Reduce the included Sail Cloud quota to 50 MiB and the plus entitlement to
-- 500 MiB. Existing objects are preserved; accounts already above their new
-- quota simply cannot reserve another upload until usage falls below it.

alter table public.account_storage_entitlements
  drop constraint if exists account_storage_entitlements_quota_bytes_check;

alter table public.account_storage_entitlements
  alter column quota_bytes set default 52428800;

update public.account_storage_entitlements
set
  quota_bytes = case
    when plan = 'plus' then 524288000
    else 52428800
  end,
  updated_at = timezone('utc', now())
where quota_bytes is distinct from case
  when plan = 'plus' then 524288000
  else 52428800
end;

alter table public.account_storage_entitlements
  add constraint account_storage_entitlements_quota_bytes_check
  check (quota_bytes between 0 and 524288000);
