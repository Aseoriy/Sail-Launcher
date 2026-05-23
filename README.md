# Sail Launcher 🚀

**Sail Hub Website**: [sailhub.netlify.app](https://sailhub.netlify.app)

Sail Launcher is a modern, feature-rich custom game and application launcher designed to consolidate all of your games in one place. It is perfect for managing non-Steam games, DRM-free titles, and emulated retro games under a single, highly customizable interface. 

It automatically fetches game metadata, covers, and hero banners directly from Steam, tracks playtime, integrates with Discord Rich Presence, and features a **fully native Cloud Save Sync engine** and **Steam Workshop Hub**.

---

## 🌟 Major Features

### ☁️ Native Cloud Save Sync (New in v4.2.0)
No external desktop clients or mounted drive letters are required! Sail Launcher communicates directly with cloud provider APIs to keep your saves safe and in sync across devices:
* **Plug-and-Play Google Drive**: Link your Google Drive account instantly using the launcher's built-in OAuth keys.
* **Microsoft OneDrive & Dropbox Support**: Configure custom client credentials to run backups over your own developer projects.
* **Mediafire Session Sync**: Directly connect via username/password with custom Developer API credentials.
* **Automated Sync Hooks**: Automatically checks for newer cloud saves on game launch and uploads zipped save backups on game exit.
* **Secure Encryption**: All authentication tokens and credentials are encrypted using Electron's native `safeStorage` (Windows DPAPI) before saving.

### 🛠️ Dedicated Steam Workshop Hub (New in v4.2.0)
Browse and install mods for your games directly inside the launcher:
* **Dedicated Full-Page Sidebar Tab**: A beautiful, spacious grid for exploring Steam Workshop mods.
* **Infinite Scroll Pagination**: Smooth scrolling queries pages of mods dynamically as you scroll.
* **Automatic Extraction**: Handles zipped, raw, RAR, and `.7z` archives smoothly (includes `.asar` unpacked binary fixes so extraction works seamlessly in packaged releases).

### 🎨 Customization & Frosted-Glass Visuals
* **Frosted-Glass Mode**: Enable translucent layouts in the redesigned vertical Settings panel to view your game library directly behind a beautiful blur filter.
* **Custom Theme Creator**: Build your own color schemes, adjusting backdrop blur, borders, fonts, and window transparency.
* **Animated Backgrounds**: Pulse, Grid, Wave, Ripple, and Frost Sweep animations.
* **Big Picture Mode**: Console-style interface with full gamepad navigation and booting sound effects.

---

## 📋 Comprehensive Feature List

<details>
<summary><b>Click to expand full feature details</b></summary>
<ul>
  <li>
    <details>
      <summary>🚀 <b>Core Launching & Automation</b></summary>
      
      - **Advanced Launch Options**: Launch games as Administrator or with High CPU Priority.
      - **Automatic EXE Detective**: Automatically scans game directories to locate the main game executable.
      - **Companion App Support**: Automatically open trainers, overlay applications, or Discord alongside your games.
      - **Pre/Post Launch Scripts**: Run custom Batch (`.bat`) or PowerShell (`.ps1`) scripts before a game starts or after it exits.
      - **Launch Splash Screen**: Premium animated splash screen transitions during launch sequences.
      - **CLI Autolaunch**: Launch specific games directly via command-line arguments.
      - **Desktop Shortcut Creator**: Generate custom Windows shortcuts linked directly to the launcher.
    </details>
  </li>
  <li>
    <details>
      <summary>🎮 <b>Game Library & Management</b></summary>

      - **Auto-Import Steam Library**: Scans your local Steam directories and imports all installed games in one click.
      - **Metadata Downloader**: Fetches details, screenshots, descriptions, and banners from Steam API.
      - **Emulator & ROM support**: Add retro systems and run ROMs with customized command-line parameters.
      - **Playtime Tracker**: Tracks total play hours and session lengths for every application.
      - **Running Detection**: Real-time status updates showing which games are currently running, with a force-stop button.
      - **Global Search & Sorting**: Search by name or tag, and sort by playtime, name, or recency.
      - **Favorites System**: Keep your most played games starred at the top.
    </details>
  </li>
  <li>
    <details>
      <summary>🎨 <b>Interface & Animations</b></summary>

      - **10+ Built-in Themes**: Midnight, Cyberpunk, Forest, Neon, and more.
      - **Dynamic Transitions**: Sleek slide-up and cross-fade animations on page entry, modal closures, and settings window exits.
      - **Custom Fonts**: Support for loading external `.ttf` or `.otf` files.
      - **Tile Shapes & Scaling**: Customize grid layouts with Squircle, Circle, Pill, or Square tiles in multiple sizes.
      - **Resizable Sidebar**: Drag the sidebars to customize layout widths.
    </details>
  </li>
  <li>
    <details>
      <summary>💾 <b>Backups & Version History</b></summary>

      - **Rolling Local Backups**: Automatically backs up save folders locally with a 3-version rolling history.
      - **Cloud Save Restore**: Browse versions and restore previous save states in one click from the UI.
      - **Process Blocking Mode**: Option to display a "Syncing..." UI block on game launch/exit to ensure data safety before launching.
    </details>
  </li>
  <li>
    <details>
      <summary>🌐 <b>Social & Protocol Integration</b></summary>

      - **Discord Rich Presence (RPC)**: Shares your active game status and playtime directly to your Discord profile.
      - **Sail Hub Protocol**: Installs themes and plugins directly from the web using `sail-launcher://` protocol links.
      - **Friend Activity Bar**: Integrates Steam/Discord friend statuses directly in the launcher.
    </details>
  </li>
</ul>
</details>

---

## 📸 Screenshots

<img width="2190" height="1298" alt="image" src="https://github.com/user-attachments/assets/b3a809df-aeae-4479-834e-6cead9961976" />

<img width="2136" height="1229" alt="image" src="https://github.com/user-attachments/assets/506eaf88-3b3a-4585-86d9-1b2641be8fa1" />

