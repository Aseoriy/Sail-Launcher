# Sail Hub R2 migration report

Migration completed at approximately `2026-07-27T05:50:00Z`.

## Result

- Two published Sail Hub items were migrated.
- Four referenced objects were copied to `sailhub-assets`.
- Every R2 copy was verified by byte count and SHA-256 before its item URL changed.
- Both packages and both previews now use `https://assets.sailhub.fyi`.
- The original Supabase objects remain available through the rollback window.

## Legacy inventory

The Supabase `files` and `previews` buckets contained 13 objects:

- 4 migration sources retained temporarily for rollback.
- 9 older, unreferenced objects that were not copied.

The Worker has an exact-name cleanup list for all 13 legacy objects. On or after
`2026-08-03T05:50:00Z`, its hourly schedule first verifies that no Sail Hub item
still references either legacy bucket. It then removes those exact objects and
makes both legacy buckets private. If a legacy reference remains or any cleanup
request fails, the buckets stay available and the next scheduled run retries.

No wildcard or user-prefix deletion is used for this cleanup.
