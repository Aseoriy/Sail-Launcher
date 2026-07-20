<div align="center">

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

Sail Launcher is a feature-rich desktop launcher built for managing games and applications outside a traditional storefront.

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
| **Library management** | Steam library importing, folders, favorites, tags, search, sorting, custom artwork, metadata retrieval, playtime tracking, and recently played games |
| **Launch automation** | Executable detection, administrator mode, high CPU priority, companion applications, custom arguments, pre-launch scripts, post-launch scripts, and desktop shortcuts |
| **Downloads** | Managed download queues, pause and resume support, speed limits, archive extraction, multi-part archives, installation automation, and library importing |
| **Cloud saves** | Save synchronization, automatic backups, rolling version history, restore tools, and supported cloud-provider integrations |
| **Maintenance Center** | Installation scans, broken-path detection, quick and selective repairs, modification snapshots, rollback tools, save-folder scanning, storage cleanup, and diagnostic exports |
| **Workshop and mods** | Steam Workshop browsing, SteamCMD integration, custom web sources, automatic archive extraction, and configurable download locations |
| **Customization** | Built-in themes, custom themes, animated backgrounds, custom fonts, tile layouts, gradients, visual UI editing, frosted-glass effects, and resizable sidebars |
| **Big Picture Mode** | Controller-friendly navigation, console-style presentation, boot audio, and target-monitor selection |
| **Integrations** | Discord Rich Presence, Steam metadata, external cloud providers, and the `sail-launcher://` installation protocol |

<details>
<summary><strong>View additional feature details</strong></summary>

### Game library

- Import locally installed Steam games.
- Add games, applications, emulators, and ROMs manually.
- Automatically search selected folders for the most likely executable.
- Retrieve covers, banners, descriptions, screenshots, and other metadata.
- Track total playtime and individual sessions.
- Search by title or tag.
- Sort by name, playtime, favorites, or recency.
- Highlight the most recently played title with the Continue Playing banner.
- Switch between landscape tiles and vertical poster covers.
- Detect running games and stop them from Sail.

### Launch configuration

- Run games as administrator.
- Launch games with high process priority.
- Start companion programs such as overlays or utilities.
- Run Batch or PowerShell scripts before or after a session.
- Pass custom command-line arguments.
- Generate Windows desktop shortcuts.
- Launch games through Sail command-line arguments.
- Display an optional animated launch splash screen.

### Saves and backups

- Configure save folders for individual games.
- Scan for likely save-file locations.
- Create rolling local backups.
- Synchronize saves through supported cloud providers.
- Restore previous save versions.
- Synchronize launcher settings and custom themes.
- Block game startup or shutdown while a required synchronization is running.
- Encrypt stored authentication tokens using Electron storage APIs when available.

### Downloads and installation

- Manage downloads without leaving the launcher.
- View progress, transfer speed, current file, and estimated completion time.
- Pause, resume, retry, cancel, or open a download folder.
- Apply global download speed limits.
- Handle direct downloads and supported external sources.
- Extract ZIP, RAR, 7z, and multi-part archives.
- Clean up temporary archive files after extraction.
- Detect installers and add completed games to the Sail library.

### Maintenance Center

- Scan individual games or the complete library.
- Detect missing executables and broken launch paths.
- Find missing, unreadable, or changed installation files.
- Perform quick or selective repairs.
- Track files changed outside Sail.
- Create snapshots before modifications.
- Roll back supported modifications.
- Detect unavailable save directories.
- Search for reclaimable storage.
- Export diagnostic reports for bug reports and troubleshooting.

### Interface customization

- Choose from multiple built-in themes.
- Create and export custom themes.
- Configure colors, opacity, borders, fonts, blur, and gradients.
- Drag, resize, and reposition supported interface elements.
- Add animations such as pulse, float, glow, shimmer, and gradient shift.
- Choose between multiple tile sizes and shapes.
- Load custom `.ttf` and `.otf` fonts.
- Enable animated backgrounds and translucent layouts.
- Resize or collapse interface sidebars.

</details>

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
├── cloudSync.js         # Cloud authentication and synchronization
├── maintenance/         # Scanning, repair, snapshots, and diagnostics
├── ui/                  # Shared interface components and styles
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
