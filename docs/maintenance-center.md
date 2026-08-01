# Maintenance Center

Sail Launcher v5.2.0 “Dry Dock” adds installation health, repair, cleanup, and modification history without replacing Sail’s existing installer, executable detector, downloader, backup, library, or settings systems.

## Architecture

The Electron main process owns all maintenance filesystem work. The renderer uses narrow IPC handlers and receives throttled job snapshots. `MaintenanceJobManager` provides unique IDs, bounded concurrency, per-game conflict prevention, cancellation, progress phases, results, and shutdown cancellation.

Maintenance state lives below Electron `userData/maintenance` by default:

```text
maintenance/
  manifests/<safe-game-id>.json
  manifests/<safe-game-id>.json.bak
  reports/<safe-game-id>.json
  snapshots/<safe-game-id>/<snapshot-id>/
  destructive-actions.jsonl
```

Large file lists stay out of `sail_library.json` and are not sent wholesale to the renderer. Snapshot storage can be moved in Maintenance Settings; records retain their storage root so older snapshots remain restorable after that setting changes.

## Manifest schema

Current schema version: `2`.

- `schemaVersion`, `gameId`, `installRoot`, and relative `executablePath`
- `source`, `installedAt`, `lastScannedAt`, and `creationMethod`
- `files` with relative path, size, modified time, classification, and optional SHA-256
- `mutablePaths` for user-changing data and `protectedPaths` for verification targets
- `modifications`, `repairHistory`, and the last scan summary

Migrations are explicit and incremental. A manifest that cannot be parsed or migrated is reported as unreadable and is never treated as permission to reset it. Before a valid manifest is replaced, Sail writes a recoverable `.bak`; updates use a same-directory temporary file, flush, and atomic rename.

## Verification

- `existence` verifies expected paths exist.
- `metadata` (default) also compares size and modification data.
- `deep` hashes executable, DLL, configuration, and protected files when enabled.
- Full hashing is explicit and never runs for the entire library at startup.

Baselines recognize mutable saves, logs, caches, configuration, screenshots, shader caches, and crash data. Changes below those paths do not become corruption findings by default. Inaccessible entries become structured findings or skipped records instead of failing the scan.

## Health and repair

Scans use stable issue codes and severities (`healthy`, `information`, `warning`, `error`, `critical`) for missing or moved installations/executables, missing or changed protected files, extraction remnants, multipart archives, failed downloads, save availability, disk space, manifests, potential conflicts, and dependency indicators.

Quick Repair can rediscover executables, update launcher metadata, accept a moved root, create a missing baseline, and remove known-safe incomplete fragments. Selective Repair operates only on checked supported actions. Both validate afterward. Rebuilding or accepting a manifest remains explicit.

Information-level findings may be hidden globally in Maintenance Settings or independently for each game. This is a presentation filter: the underlying report remains available to diagnostics and can be shown again. Clear Activity similarly dismisses completed jobs and older dashboard activity without deleting scan reports, repair history, manifests, or modification snapshots.

Maintenance confirmations use Sail's theme-aware dialog layer rather than native operating-system message boxes. Destructive or overwrite actions receive warning styling, keyboard focus remains trapped inside the dialog, and Escape safely cancels confirmations.

Clean Reinstall Preparation reuses Sail’s save and game backup handlers, then opens Game Downloads. It deliberately does not remove the installation or begin a download automatically. If the source is unavailable, the user can choose a replacement package through the existing flow.

## Modification snapshots

Before a Sail-managed modification applies known file operations, the snapshot API copies existing regular files and records paths that will be created. Rollback restores replaced files and removes only recorded added regular files after the user reviews the impact. Snapshot creation, deletion, and rollback are jobs.

Workshop currently downloads outside the installation through SteamCMD. Since Sail cannot observe a complete set of game-directory writes, those records are `partial` with no claimed rollback. Installers changing the registry or files outside the game root require the same classification.

## Cleanup

Cleanup is preview-first. Candidates include category, path, size, reason, risk, and selection. Clearly Sail-owned `.aria2`, `.partial`, and `.crdownload` fragments may be preselected. Archives, multipart pieces, installers, extraction folders, caches, snapshots, duplicates, and ambiguous files require explicit selection; age alone is never sufficient. Delete revalidates every path and refuses linked or non-regular entries.

Completed destructive actions, including safe-fragment cleanup, snapshot retention, explicit snapshot deletion, and rollback, are appended to `destructive-actions.jsonl` for local auditability.

## Dependency providers

Providers cover Visual C++ runtimes, legacy DirectX indicators, .NET Desktop Runtime, Java, emulator firmware/BIOS hints, and companion apps. Results distinguish detected, missing, uncertain, and not applicable. Providers do not download or execute installers and can later accept per-game overrides.

## Save-folder rescans

Save detection presents every plausible folder instead of silently committing to one result. Rescans search the game installation first, per-game custom roots, global custom roots, and then common Windows save locations. The user chooses the actual folder from the ranked candidates. This supports games that store saves beside installed program files rather than under Documents or AppData.

## Diagnostics and privacy

Diagnostic JSON contains launcher version, game identity, summary, issue codes, timestamps, manifest version, findings, repair history, dependencies, and non-sensitive logs. Recursive redaction removes tokens, API keys, cookies, credentials, sensitive environment values, and unnecessary home-directory identity.

## Release QA

Capture `docs/screenshots/maintenance-center.png` after installer smoke testing. Validate keyboard focus, collapsed navigation, custom themes, frosted glass, cancellation, restart recovery, and cleanup confirmations before publishing.
