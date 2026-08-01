# Sail Cloud storage (v5.3.0)

Sail uses a fixed storage route when a launcher user is signed in:

| Data | Storage |
| --- | --- |
| Account identity, usernames, quotas, revisions, ownership, and manifests | Supabase Auth/Postgres |
| Public profile avatars | Supabase Storage (`avatars`) |
| Profiles, libraries, presets, portable launcher settings, private themes, game configurations, and opt-in game saves | Private Cloudflare R2 (`sail-account-sync`) |
| Public Sail Hub packages and previews | Public Cloudflare R2 (`sailhub-assets`) |
| Full game saves | Opt-in Sail Cloud and/or user-linked Google Drive, Dropbox, OneDrive, or MediaFire |

Signed-out users keep the existing provider-based launcher sync behavior.

## Public endpoints

- `https://storage-api.sailhub.fyi` — authenticated storage API Worker
- `https://assets.sailhub.fyi` — immutable public Sail Hub objects

The Worker accepts the Sail account access token. It derives the user ID from
Supabase Auth and never accepts a caller-supplied identity as authorization.

## Limits and retention

- Private object: 90 MiB
- Included private quota: 500 MiB
- Upgrade entitlement: 1 GiB
- Sail Hub package: 100 MiB
- Sail Hub preview: 5 MiB
- Upload URL lifetime: 15 minutes
- Reservation lifetime: 1 hour
- Uncommitted-object cleanup: after 1 day
- Private download URL lifetime: 5 minutes
- Profile/library/preset/theme retention: latest version
- Launcher configuration, game configuration, and game-save retention: 1, 3, or 5 versions

The launcher warns users before Sail Cloud game-save sync is enabled because
save archives consume the included quota more quickly. The account panel lists
all logical Sail Cloud files and can permanently delete an item and every
retained version after confirmation.

## Deployment

The Worker project is in `cloudflare-worker/`. Its sensitive bindings are:

- `SUPABASE_SERVICE_ROLE_KEY`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `INTERNAL_PURGE_SECRET`

Never put these values in `wrangler.jsonc`, source control, renderer code, or
website JavaScript. R2 credentials must be scoped to only
`sail-account-sync` and `sailhub-assets`.

Database changes are forward-only migrations in `supabase/migrations/`.
Account deletion calls the Worker purge endpoint before deleting the Supabase
user, so a failed R2 purge leaves the account intact and retryable.

## Rollback window

The migration copies the four assets referenced by current Sail Hub items,
verifies hashes and byte counts, updates item URLs, and leaves the old
Supabase `files` and `previews` objects in place for seven days. Unreferenced
legacy objects are reported separately; they are not silently copied.
