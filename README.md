<div align="center">
  
# *linux coming soon btw*
  
# Sail Launcher

### A customizable Windows launcher for games, applications, emulators, saves, mods, and more.

[![Latest Release](https://img.shields.io/github/v/release/Aseoriy/Sail-Launcher?style=flat-square)](https://github.com/Aseoriy/Sail-Launcher/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Aseoriy/Sail-Launcher/total?style=flat-square)](https://github.com/Aseoriy/Sail-Launcher/releases)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square&logo=windows11&logoColor=white)](https://github.com/Aseoriy/Sail-Launcher)
[![Electron](https://img.shields.io/badge/built%20with-Electron-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![GitHub Stars](https://img.shields.io/github/stars/Aseoriy/Sail-Launcher?style=flat-square)](https://github.com/Aseoriy/Sail-Launcher/stargazers)

[**Download Sail Launcher**](https://github.com/Aseoriy/Sail-Launcher/releases/latest) ·
[**Website**](https://sail-launcher.sailhub.fyi) ·
[**Sail Hub**](https://sailhub.fyi) ·
[**Report a Bug**](https://github.com/Aseoriy/Sail-Launcher/issues/new)

</div>

---

## About Sail Launcher

Sail Launcher is a super cool game/app launcher that has a built in game downloader that scrapes popular sites like steamrip and fitgirl.

It combines library management, metadata retrieval, launch automation, playtime tracking, cloud-save synchronization, Steam Workshop support, downloads, installation tools, maintenance utilities, and extensive interface customization in one application.

Sail can manage regular Windows applications, non-Steam games, emulators, ROMs, utilities, and other executable software.

## Preview

<table>
  <tr>
    <td width="50%">
      <img alt="Sail Launcher screenshot" src="https://github.com/user-attachments/assets/9fb3128d-0c1b-414e-b1ba-c042361a23cc">
    </td>
    <td width="50%">
      <img alt="Sail Launcher screenshot" src="https://github.com/user-attachments/assets/bdc76c5c-2be6-42eb-956c-f40f28bc2732">
    </td>
  </tr>
</table>

## Highlights

| Area | Features |
| --- | --- |
| **Library management** | Steam library importing, folders, favorites, tags, search, sorting, filters, result counts, empty states, custom artwork, metadata retrieval, achievement progress, playtime tracking, and recently played games |
| **Achievements** | Read-only local achievement tracking, optional Steam import, official names and artwork, recent unlocks, search and filters, game-page details, library badges, and unlock notifications |
| **Launch automation** | Executable detection, live launch status, administrator mode, high CPU priority, companion applications, custom arguments, pre-launch scripts, post-launch scripts, crash-safe session recovery, true fullscreen controls, and desktop shortcuts |
| **Accounts and sync** | Sail accounts, multiple launcher profiles, libraries and presets, profile PINs, avatars, crash-safe encrypted login recovery, Sail Cloud, Sync V2 schedules, per-category destinations, conflict modes, Sync Confidence, and local/cloud replacement controls |
| **Downloads** | Managed queues and history, active-download search, category filters, supported game-source search, cover and screenshot browsing, pause/resume/retry/cancel, safe cancellation states, retained-download quarantine details, bulk failed-download retry, completed-history cleanup, speed limits, archive extraction, installation automation, and library importing |
| **Cloud saves** | Sail Cloud and supported provider synchronization, Ludusavi-backed save-folder discovery, optional per-game save uploads, automatic backups, rolling version history, restore tools, local save compression, crash-safe post-game recovery, and safe cloud replacement of selected local data |
| **Experimental Maintenance Center** | An opt-in installation-health workspace with broken-path detection, quick and selective repairs, modification snapshots, rollback tools, save-folder scanning, storage cleanup, and diagnostic exports |
| **Workshop and mods** | Steam Workshop browsing, SteamCMD integration, custom web sources, automatic archive extraction, and configurable download locations |
| **Customization** | Built-in themes, custom themes, animated backgrounds, custom fonts, tile layouts, gradients, visual UI editing, frosted-glass effects, and resizable sidebars |
| **Big Picture Mode** | Controller-friendly navigation, console-style presentation, boot audio, target-monitor selection, and proper fullscreen behavior |
| **Integrations** | Discord Rich Presence, Steam metadata, external cloud providers, and the `sail-launcher://` installation protocol |

[View additional feature details](https://sail-launcher.sailhub.fyi/features)


## Installation

Sail Launcher currently targets Windows.

1. Open the [latest release](https://github.com/Aseoriy/Sail-Launcher/releases/latest).
2. Download the Windows installer.
3. Run the installer and select an installation directory.
4. Open Sail Launcher.
5. Import your Steam library or add an application manually.

Windows may display a security confirmation for applications downloaded outside the Microsoft Store. Confirm that the installer was downloaded from this repository before running it.

## Building from Source

### Requirements

- Windows
- Git
- A current Node.js LTS release
- npm

### Setup

```bash
git clone https://github.com/Aseoriy/Sail-Launcher.git
cd Sail-Launcher
npm install
npm start
```

### Available commands

| Command | Description |
| --- | --- |
| `npm start` | Start Sail Launcher through Electron |
| `npm test` | Run the automated test suite |
| `npm run check` | Check important JavaScript files and run the tests |
| `npm run build` | Create a Windows NSIS installer |

Packaged builds are written to the `dist` directory.

## Project Structure

```text
Sail-Launcher/
├── main.js              # Electron main process and native integrations
├── index.html           # Main application interface
├── accounts/            # Accounts, profiles, protected sessions, and Sail Cloud
├── achievements/        # Local tracking, Steam metadata, and achievement services
├── sync/                # Portable data and synchronization logic
├── maintenance/         # Save discovery, scanning, repair, snapshots, and diagnostics
├── runtime/             # Recovery, downloads, quarantine, and process coordination
├── security/            # IPC authorization, navigation policy, and remote-data validation
├── ui/                  # Shared renderer components and styles
├── tests/               # Automated tests
├── package.json         # Dependencies, scripts, and build configuration
└── icon.ico             # Application icon
```

## Reporting Bugs

Bug reports and feature requests are welcome through [GitHub Issues](https://github.com/Aseoriy/Sail-Launcher/issues).

A useful bug report should include:

- The Sail Launcher version
- Your Windows version
- Steps that reproduce the issue
- What you expected to happen
- What happened instead
- Relevant screenshots or diagnostic information

Remove API keys, account tokens, email addresses, save files, and other private information before posting logs or diagnostic files publicly.

## Contributing

Contributions are welcome.

1. Fork the repository.
2. Create a branch for the change.
3. Make and test the changes.
4. Run `npm run check`.
5. Submit a pull request explaining what changed and why.

Keep pull requests focused where possible. Large interface or architectural changes should be discussed in an issue before implementation.

## Data and Security

Sail Launcher can connect to external services for features such as cloud synchronization, metadata, Discord Rich Presence, downloads, and Workshop access.

Authentication tokens are stored locally and use Electron's native secure-storage functionality when it is available. Never include account credentials, API keys, tokens, or private diagnostic information in public issues.

Privileged file, process, profile, and transfer operations are limited to the trusted Sail window and main-process-owned permissions. Store and Sources web content runs in isolated, sandboxed sessions without Node.js access, and supported external links open outside the privileged launcher page.

Remote data and navigation are validated before use. Device-specific paths, local achievement-source locations, credentials, and other protected settings stay on the current PC instead of being copied into portable or Sail Cloud data.

All third-party integrations are optional and remain subject to their respective providers' availability and terms.

## Legal Notice

Sail Launcher is an independent project and is not affiliated with or endorsed by Valve, Steam, Discord, Google, Microsoft, Dropbox, or any other third-party platform mentioned in this repository.

Sail Launcher does not grant ownership or usage rights for games, applications, modifications, or downloadable content. Users are responsible for ensuring that they have permission to access, download, modify, and use content managed through the launcher.

---

<div align="center">

Built by [Aseoriy](https://github.com/Aseoriy)

[Website](https://sail-launcher.sailhub.fyi) ·
[Sail Hub](https://sailhub.fyi) ·
[Releases](https://github.com/Aseoriy/Sail-Launcher/releases) ·
[Issues](https://github.com/Aseoriy/Sail-Launcher/issues)

</div>

