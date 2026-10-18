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

It keeps your library, playtime, achievements, saves, and mods in one place, and you can change pretty much how all of it looks. It works with Steam games, non-Steam games, emulators, ROMs, and any other program you want to launch.

Sail runs on Windows and Linux. On Linux, native games launch directly and Windows games run through Proton. Linux is in beta, see the [Linux section](#linux) for what works and what doesn't yet.

## Preview

<table>
  <tr>
    <td width="50%">
      <img alt="Sail Launcher with the default layout" src="https://github.com/user-attachments/assets/5dde5fce-e5f9-4a84-a4a0-4480dabc3038">
    </td>
    <td width="50%">
      <img alt="Sail Launcher with the Steam-style layout plugin" src="https://github.com/user-attachments/assets/26fbb8f8-6b11-4b7e-ba9a-8ec79af9e7a0">
    </td>
  </tr>
</table>

## Highlights

| Area | Features |
| --- | --- |
| **Library** | Steam library importing, folders, favorites, tags, search and filters, custom artwork, metadata, and playtime tracking |
| **Achievements** | Local achievement tracking, optional Steam import, official names and artwork, and unlock notifications |
| **Launching** | Executable detection, custom arguments, pre/post-launch scripts, companion apps, administrator mode, high CPU priority, and desktop shortcuts |
| **Accounts and sync** | Sail accounts, multiple profiles with PINs, Sail Cloud, and scheduled sync with conflict handling |
| **Downloads** | A download manager with game-source search, pause/resume/retry, archive extraction, installer automation, and automatic library importing |
| **Cloud saves** | Save-folder discovery, backups with version history, restore tools, and cloud-save syncing to Sail Cloud and other providers (Linux has Sail Cloud only for now) |
| **Workshop and mods** | Steam Workshop browsing through SteamCMD and custom web sources |
| **Customization** | Built-in and custom themes, animated backgrounds, custom fonts, tile layouts, a visual UI editor, and frosted-glass effects |
| **Plugins** | A plugin manager, a settings window for each plugin, and a plugin API for layouts, menus, and themes |
| **Linux** | Proton and UMU for Windows games, native Linux games, Steam Workshop, and keyring-backed accounts |

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

Sail on Linux is in beta. Grab the package for your distribution from the [latest release](https://github.com/Aseoriy/Sail-Launcher/releases/latest).

| Distribution | Package | Install |
| --- | --- | --- |
| Debian, Ubuntu, Linux Mint, Pop!_OS | `.deb` | `sudo apt install ./Sail-Launcher-<version>-amd64.deb` |
| Fedora and other RPM-based distributions | `.rpm` | `sudo dnf install ./Sail-Launcher-<version>-x86_64.rpm` |
| Arch Linux, CachyOS, and everything else | `.AppImage` | `chmod +x Sail-Launcher-<version>-x86_64.AppImage`, then run it |

The `.deb` and `.rpm` pull in what Sail needs and add it to your app menu. On Ubuntu and Linux Mint, use the `.deb` if you can.

**Good to know**

- You need a 64-bit distribution (Ubuntu 22.04 or newer, or something equivalent) with a normal desktop install.
- The AppImage needs FUSE 2 (`libfuse2`, `fuse-libs`, or `fuse2`). Without it, run it with `--appimage-extract-and-run`.
- Accounts need a keyring (KDE Wallet, GNOME Keyring, or KeePassXC). Without one, accounts stay off and everything else still works.
- Windows games run through Proton using [UMU](https://github.com/Open-Wine-Components/umu-launcher). Sail can download GE-Proton and UMU for you in **Settings > Compatibility**, which needs Python 3.
- Not on Linux yet: Google Drive, OneDrive and Dropbox sync, the Maintenance Center, emulator games, and spell checking.

Tested on Kubuntu 26.04 (real hardware) and on Ubuntu 24.04, Fedora 44, and Arch Linux in virtual machines. Other distributions should work, but if one doesn't, please [open an issue](https://github.com/Aseoriy/Sail-Launcher/issues/new) with your distribution and desktop.

**Troubleshooting**

| Problem | Fix |
| --- | --- |
| The AppImage closes right away on Ubuntu 24.04 or Linux Mint 22 with an SUID sandbox message | Install the `.deb`, or run the AppImage with `--no-sandbox` |
| Accounts are turned off | Start or unlock your keyring and restart Sail |
| A Windows game won't start | Install a Proton version in **Settings > Compatibility** |

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

Bug reports and feature requests go in [GitHub Issues](https://github.com/Aseoriy/Sail-Launcher/issues). Please include your Sail version, your Windows version (or your Linux distribution, desktop, and package type), the steps to reproduce it, and a screenshot if you can. Remove API keys, tokens, emails, and save files before posting any logs.

## Contributing

Contributions are welcome.

1. Fork the repository.
2. Create a branch for the change.
3. Make and test the changes.
4. Run `npm run check`.
5. Submit a pull request explaining what changed and why.

Keep pull requests focused where possible. Large interface or architectural changes should be discussed in an issue before implementation.

## Data and Security

Sail can connect to outside services for things like cloud sync, metadata, Discord Rich Presence, downloads, and the Workshop. All of them are optional.

Login tokens are stored locally using Electron's secure storage (on Linux, only when a real keyring backs it), and device-specific paths and credentials stay on your PC instead of going into Sail Cloud. Never put tokens, API keys, or other private info in public issues.

## License

Sail Launcher is free software under the [GNU General Public License v3.0](LICENSE). The license covers Sail's own code, not games, downloads, or other people's content you use with it.

## Legal Notice

Sail Launcher is an independent project and is not affiliated with or endorsed by Valve, Steam, Proton, Discord, Google, Microsoft, Dropbox, or any other platform mentioned here. UMU and GE-Proton are separate projects with their own maintainers.

Sail doesn't give you rights to any games or content. You're responsible for having permission to access, download, and use what you manage with it.

---

<div align="center">

Built by [Aseoriy](https://github.com/Aseoriy)

[Website](https://sail-launcher.sailhub.fyi) ·
[Sail Hub](https://sailhub.fyi) ·
[Releases](https://github.com/Aseoriy/Sail-Launcher/releases) ·
[Issues](https://github.com/Aseoriy/Sail-Launcher/issues)

</div>

