<div align="center">

# Sail Launcher

### A customizable launcher for games, applications, emulators, saves, mods, and more, for Windows and Linux.

[![Latest Release](https://img.shields.io/github/v/release/Aseoriy/Sail-Launcher?style=flat-square)](https://github.com/Aseoriy/Sail-Launcher/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Aseoriy/Sail-Launcher/total?style=flat-square)](https://github.com/Aseoriy/Sail-Launcher/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-0078D4?style=flat-square)](https://github.com/Aseoriy/Sail-Launcher)
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

Sail runs on Windows and Linux. On Linux it launches native Linux games directly and runs Windows games through Proton. Linux support is in beta, and the [Linux section](#linux) below lists what is available and what is not yet.

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
| **Plugins** | A plugin manager with live enabling and disabling, a settings window for each plugin, and a plugin API for layouts, menus, and themes |
| **First-run setup** | A short guided setup for new installs covering the theme, library layout, motion, startup behavior, and importing games. Existing installs skip it, and it can be run again from Settings |
| **Linux** | Windows games through Proton and UMU, native Linux games, Steam Workshop through SteamCMD, desktop shortcuts, start at login, and system keyring storage for accounts |
| **Integrations** | Discord Rich Presence, Steam metadata, external cloud providers, and the `sail-launcher://` installation protocol |

[View additional feature details](https://sail-launcher.sailhub.fyi/features)


## Installation

### Windows

1. Open the [latest release](https://github.com/Aseoriy/Sail-Launcher/releases/latest).
2. Download the Windows installer.
3. Run the installer and select an installation directory.
4. Open Sail Launcher.
5. Import your Steam library or add an application manually.

Windows may display a security confirmation for applications downloaded outside the Microsoft Store. Confirm that the installer was downloaded from this repository before running it.

### Linux

Sail Launcher on Linux is in beta. Download the package that matches your distribution from the [latest release](https://github.com/Aseoriy/Sail-Launcher/releases/latest).

| Distribution | Package | Install |
| --- | --- | --- |
| Debian, Ubuntu, Linux Mint, Pop!_OS, and other Debian-based distributions | `.deb` | `sudo apt install ./Sail-Launcher-<version>-amd64.deb` |
| Fedora and other RPM-based distributions | `.rpm` | `sudo dnf install ./Sail-Launcher-<version>-x86_64.rpm` |
| Arch Linux, CachyOS, and everything else | `.AppImage` | `chmod +x Sail-Launcher-<version>-x86_64.AppImage`, then run it |

Installing the `.deb` or `.rpm` pulls in the libraries Sail needs and adds Sail to your application menu. Use the `.deb` on Ubuntu and Linux Mint where you can, since it includes the permission profile those systems need.

#### Requirements

- A 64-bit (x86_64) distribution. Ubuntu 22.04 or newer, or something equivalent, is recommended.
- The usual desktop libraries (GTK 3, NSS, and similar). Every normal desktop install already has them, but a minimal or server install may not.
- **AppImage only:** FUSE 2 (`libfuse2` on Debian-based systems, `fuse-libs` on Fedora, `fuse2` on Arch). Without it, run the AppImage with `--appimage-extract-and-run`.
- **Accounts only:** a system keyring. See [Accounts and the keyring](#accounts-and-the-keyring).
- **Windows games only:** Python 3, which Sail uses to set up Proton. See [Windows games on Linux](#windows-games-on-linux).

#### Tested on

| Distribution | Package | How it was tested |
| --- | --- | --- |
| Kubuntu 26.04 (KDE Plasma) | `.deb`, AppImage | Real hardware, everyday use |
| Ubuntu 24.04 | `.deb` | Virtual machine |
| Fedora 44 | AppImage, `.rpm` | Virtual machine |
| Arch Linux | AppImage | Virtual machine |

Other distributions should work but have not been tested. If something does not, please [open an issue](https://github.com/Aseoriy/Sail-Launcher/issues/new) with your distribution and desktop environment.

#### Accounts and the keyring

Sail stores your login in your system keyring (KDE Wallet, GNOME Keyring, or any other Secret Service such as KeePassXC). If no keyring is running, accounts stay turned off and Sail tells you why. Everything else keeps working. Start or unlock your keyring and restart Sail to turn accounts on.

#### Windows games on Linux

Windows games run through Proton using [UMU](https://github.com/Open-Wine-Components/umu-launcher). Sail can download GE-Proton and UMU for you in **Settings > Compatibility**, which needs Python 3 on your system. Native Linux games are launched directly. Standalone Wine support is experimental and turned off by default.

Achievement files written by Steam emulators inside a game's Proton environment are found automatically, so games from sources such as SteamRIP report their progress without any extra setup.

#### Not available on Linux yet

- Cloud-save providers (Google Drive, OneDrive, and Dropbox).
- Save-folder discovery, backups, and restore.
- The Maintenance Center.
- Spell checking.

Sail Cloud accounts, launcher profiles, and portable settings work on Linux.

#### Troubleshooting

| Problem | Cause | Fix |
| --- | --- | --- |
| The AppImage says it requires FUSE | FUSE 2 is not installed | Install FUSE 2 (see the requirements above), or run the AppImage with `--appimage-extract-and-run` |
| The AppImage closes immediately on Ubuntu 24.04 or Linux Mint 22, with a message about the SUID sandbox | Those systems restrict the browser sandbox the AppImage uses | Install the `.deb` instead, or run the AppImage with `--no-sandbox` |
| Accounts are turned off | No keyring is running | Start or unlock your keyring and restart Sail |
| A Windows game will not start | Proton is not set up | Open **Settings > Compatibility** and install a Proton version |

## Building from Source

### Requirements

- Windows or Linux
- Git
- Node.js 22
- npm
- Linux only: `make` and a C compiler, for the small native helper

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
| `npm run build:linux` | Create the Linux `.AppImage` and `.deb` packages |
| `npm run build:linux:rpm` | Create the Linux `.rpm` package. Needs `rpmbuild`, which is the `rpm` package on Debian-based systems and `rpm-build` on Fedora |
| `npm run build:linux:all` | Create the `.AppImage`, `.deb`, and `.rpm` packages together |

On Linux, install the dependencies and Electron explicitly, then build the native helper before starting Sail:

```bash
git clone https://github.com/Aseoriy/Sail-Launcher.git
cd Sail-Launcher
npm ci --ignore-scripts
npm run install:electron
npm run rebuild:linux
npm run build:native
npm start
```

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
├── runtime/             # Recovery, downloads, quarantine, process coordination, and Linux compatibility
├── native/              # Linux native supervisor and helpers
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
- Your Windows version, or your Linux distribution, desktop environment, and package type (`.deb`, `.rpm`, or AppImage)
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

Authentication tokens are stored locally and use Electron's native secure-storage functionality when it is available. On Linux they are only stored when a real system keyring backs it. Never include account credentials, API keys, tokens, or private diagnostic information in public issues.

Privileged file, process, profile, and transfer operations are limited to the trusted Sail window and main-process-owned permissions. Store and Sources web content runs in isolated, sandboxed sessions without Node.js access, and supported external links open outside the privileged launcher page.

Remote data and navigation are validated before use. Device-specific paths, local achievement-source locations, credentials, and other protected settings stay on the current PC instead of being copied into portable or Sail Cloud data.

All third-party integrations are optional and remain subject to their respective providers' availability and terms.

## Legal Notice

Sail Launcher is an independent project and is not affiliated with or endorsed by Valve, Steam, Proton, Discord, Google, Microsoft, Dropbox, or any other third-party platform mentioned in this repository. UMU and GE-Proton are separate projects with their own maintainers.

Sail Launcher does not grant ownership or usage rights for games, applications, modifications, or downloadable content. Users are responsible for ensuring that they have permission to access, download, modify, and use content managed through the launcher.

---

<div align="center">

Built by [Aseoriy](https://github.com/Aseoriy)

[Website](https://sail-launcher.sailhub.fyi) ·
[Sail Hub](https://sailhub.fyi) ·
[Releases](https://github.com/Aseoriy/Sail-Launcher/releases) ·
[Issues](https://github.com/Aseoriy/Sail-Launcher/issues)

</div>

