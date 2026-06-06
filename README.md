# Sail Launcher 🚀

## PLEASE REPORT ANY BUGS YOU FIND

**Sail Hub Website**: [sailhub.fyi](https://sailhub.fyi)

Sail Launcher is a modern, feature-rich custom game and application launcher. It is perfect for managing non-Steam games "ones you dont *own*", and emulated retro games.

It automatically fetches game metadata, covers, and hero banners directly from Steam, tracks playtime, integrates with Discord Rich Presence, and features a fully native Cloud Save Sync engine and Steam Workshop Hub.

---

## 📋 Comprehensive Feature List

<details>
<summary><b>Click to expand full feature details</b></summary>
<ul>
  <li>
    <details>
      <summary>🚀 <b>Core Launching & Automation</b></summary>
      <ul>
        <li><b>Advanced Launch Options</b>: Launch games as Administrator or with High CPU Priority.</li>
        <li><b>Automatic EXE Detective</b>: Automatically scans game directories to locate the main game executable.</li>
        <li><b>Companion App Support</b>: Automatically open trainers, overlay applications, or Discord alongside your games.</li>
        <li><b>Pre/Post Launch Scripts</b>: Run custom Batch (<code>.bat</code>) or PowerShell (<code>.ps1</code>) scripts before a game starts or after it exits.</li>
        <li><b>Launch Splash Screen</b>: Premium animated splash screen transitions during launch sequences.</li>
        <li><b>CLI Autolaunch</b>: Launch specific games directly via command-line arguments.</li>
        <li><b>Desktop Shortcut Creator</b>: Generate custom Windows shortcuts linked directly to the launcher.</li>
      </ul>
    </details>
  </li>
  <li>
    <details>
      <summary>🎮 <b>Game Library & Management</b></summary>
      <ul>
        <li><b>Auto-Import Steam Library</b>: Scans your local Steam directories and imports all installed games in one click.</li>
        <li><b>Save File Detection</b>: Automatically detects save file locations when entering a steam app id (currently in beta).</li>
        <li><b>Library Sorting</b>: Sorts your library alphabetically or by favorites.</li>
        <li><b>Metadata Downloader</b>: Fetches details, screenshots, descriptions, and banners from Steam API.</li>
        <li><b>Emulator & ROM support</b>: Add retro systems and run ROMs with customized command-line parameters.</li>
        <li><b>Playtime Tracker</b>: Tracks total play hours and session lengths for every application.</li>
        <li><b>Running Detection</b>: Real-time status updates showing which games are currently running, with a force-stop button.</li>
        <li><b>Global Search & Sorting</b>: Search by name or tag, and sort by playtime, name, or recency.</li>
        <li><b>Favorites System</b>: Keep your most played games starred at the top.</li>
      </ul>
    </details>
  </li>
  <li>
    <details>
      <summary>🔌 <b>Workshop, Sources & Mods</b></summary>
      <ul>
        <li><b>Dedicated Steam Workshop Hub (v4.2.0)</b>: Browse, search, and install mods for your games inside a dedicated full-page tab.</li>
        <li><b>Steam Workshop Downloader</b>: Download Workshop items anonymously using SteamCMD directly from the game page.</li>
        <li><b>Custom Web Sources (New in v4.2.2)</b>: Add and manage custom website URLs (e.g. repacks or mod guides) to browse inside the launcher.</li>
        <li><b>Built-in Web Browser (New in v4.2.2)</b>: Integrated web browser with back/forward history buttons and external link navigation confirmations.</li>
        <li><b>Download Location Chooser (New in v4.2.2)</b>: Choose custom folders when downloading files from sources.</li>
        <li><b>Automatic Extraction</b>: Handles zipped, raw, RAR, and <code>.7z</code> mod archives automatically (with packaged release fixes).</li>
      </ul>
    </details>
  </li>
  <li>
    <details>
      <summary>🎨 <b>Interface, Customization & Visuals</b></summary>
      <ul>
        <li><b>Frosted-Glass Mode (v4.2.0)</b>: Enable translucent layouts in settings with fixed background blobs and physics-based spring animations.</li>
        <li><b>Custom Theme Creator (v4.2.0)</b>: Build custom color schemes, adjusting backdrop blur, borders, fonts, and opacity.</li>
        <li><b>Animated Backgrounds (v4.2.0)</b>: Pulse, Grid, Wave, Ripple, and Frost Sweep animations.</li>
        <li><b>Big Picture Mode (v4.2.0)</b>: Console-style interface with full gamepad navigation, boot sounds, and monitor target selection.</li>
        <li><b>Collapsible Sidebar (New in v4.2.2)</b>: Collapsible folders sidebar with fixed favorites spacing and responsive layouts.</li>
        <li><b>10+ Built-in Themes</b>: Midnight, Cyberpunk, Forest, Neon, and more.</li>
        <li><b>Dynamic Transitions</b>: Sleek slide-up and cross-fade animations on page entry, modal closures, and settings exits.</li>
        <li><b>Custom Fonts</b>: Support for loading external <code>.ttf</code> or <code>.otf</code> files.</li>
        <li><b>Tile Shapes & Scaling</b>: Customize grid layouts with Squircle, Circle, Pill, or Square tiles in multiple sizes.</li>
        <li><b>Resizable Sidebars</b>: Drag both main and social sidebars to customize layout widths.</li>
      </ul>
    </details>
  </li>
  <li>
    <details>
      <summary>💾 <b>Backups, Sync & Version History</b></summary>
      <ul>
        <li><b>Native Cloud Save Sync (v4.2.0)</b>: Sync saves directly with Google Drive, OneDrive, Dropbox, or Mediafire APIs.</li>
        <li><b>Auto Settings Sync (New in v4.2.2)</b>: Automatically download and import launcher settings and custom themes upon linking a sync provider.</li>
        <li><b>Secure Encryption</b>: Authentication credentials and tokens are encrypted securely using Electron's native <code>safeStorage</code>.</li>
        <li><b>Rolling Local Backups</b>: Automatically backs up save folders locally with a 3-version rolling history.</li>
        <li><b>Cloud Save Restore</b>: Browse and restore previous save states in one click from the UI.</li>
        <li><b>Process Blocking Mode</b>: Option to display a "Syncing..." UI block on game launch/exit to ensure data safety.</li>
      </ul>
    </details>
  </li>
  <li>
    <details>
      <summary>🌐 <b>Social & Protocol Integration</b></summary>
      <ul>
        <li><b>Discord Rich Presence (RPC)</b>: Shares your active game status and playtime directly to your Discord profile.</li>
        <li><b>Sail Hub Protocol</b>: Installs themes and plugins directly from the web using <code>sail-launcher://</code> protocol links.</li>
        <li><b>Friend Activity Bar</b>: Integrates Steam/Discord friend statuses directly in the launcher.</li>
      </ul>
    </details>
  </li>
</ul>
</details>

---

## 📸 Screenshots

<img width="2350" height="1368" alt="image" src="https://github.com/user-attachments/assets/24f488b6-4e42-40af-aaef-e9037818a554" />

<img width="2350" height="1368" alt="image" src="https://github.com/user-attachments/assets/2a7ff32d-62fb-4982-8de0-c170d9c035d2" />

