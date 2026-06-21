# Sail Launcher 🚀

## PLEASE REPORT ANY BUGS YOU FIND

**Sail Launcher Website**: [Website](https://sail-launcher.sailhub.fyi)

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
        <li><b>Save File Detection (Improved in v5.0.0)</b>: Automatically detects save file locations when entering a Steam app ID. The Browse button now shows as "Scan" and actively triggers a scan when enabled, and the Override button toggles to "Cancel" for a cleaner flow.</li>
        <li><b>Library Sorting</b>: Sorts your library alphabetically or by favorites.</li>
        <li><b>Metadata Downloader</b>: Fetches details, screenshots, descriptions, and banners from Steam API.</li>
        <li><b>Emulator & ROM support</b>: Add retro systems and run ROMs with customized command-line parameters.</li>
        <li><b>Playtime Tracker</b>: Tracks total play hours and session lengths for every application.</li>
        <li><b>Running Detection</b>: Real-time status updates showing which games are currently running, with a force-stop button.</li>
        <li><b>Global Search & Sorting</b>: Search by name or tag, and sort by playtime, name, or recency.</li>
        <li><b>Favorites System</b>: Keep your most played games starred at the top.</li>
        <li><b>Continue Playing Banner (New in v5.0.0)</b>: A featured banner above your library grid highlighting your last played game with cover art, playtime, and a quick-play button.</li>
        <li><b>Poster Cover-Tiles (New in v5.0.0)</b>: Landscape cover-art tiles by default, with a Vertical (Poster) toggle in Settings → Appearance.</li>
      </ul>
    </details>
  </li>
  <li>
    <details>
      <summary>📥 <b>Game Downloads, Debrid & Auto-Install (New in v5.0.0)</b></summary>
      <ul>
        <li><b>Built-in Download Engine</b>: Bundled aria2 engine handles direct file-host links and magnet/torrents in-app, with progress, speed limiting, and resume support.</li>
        <li><b>Multi-Source Search</b>: Search FitGirl and SteamGG at once, with results shown as animated cover-art cards and a source badge.</li>
        <li><b>Debrid Service Integration</b>: Connect TorBox, Real-Debrid, AllDebrid, Premiumize, or Debrid-Link with a single API key to unlock SteamRIP and filehosts like DataNodes, AkiraBox, and VikingFile, with live connection status and resolved-link caching.</li>
        <li><b>PixelDrain Cloudflare Worker Proxy</b>: Transparently routes PixelDrain downloads through a configurable worker pool to bypass the 10GB daily rate limit.</li>
        <li><b>Auto-Install & Library Integration</b>: Finished downloads are extracted or silently installed and added to your library automatically with fetched Steam art and metadata.</li>
        <li><b>Multi-Part Archive Handling</b>: Automatically groups and extracts part files, including those nested inside <code>.rar</code> archives, with junk files cleaned up afterward.</li>
        <li><b>Floating Downloads Dock</b>: Live progress, speed, ETA, and current part, with retry, cancel, and "open folder" actions.</li>
      </ul>
    </details>
  </li>
  <li>
    <details>
      <summary>🔌 <b>Workshop, Sources & Mods</b></summary>
      <ul>
        <li><b>Dedicated Steam Workshop Hub</b>: Browse, search, and install mods for your games inside a dedicated full-page tab.</li>
        <li><b>Steam Workshop Downloader</b>: Download Workshop items anonymously using SteamCMD directly from the game page.</li>
        <li><b>Custom Web Sources</b>: Add and manage custom website URLs (e.g. repacks or mod guides) to browse inside the launcher.</li>
        <li><b>Built-in Web Browser</b>: Integrated web browser with back/forward history buttons and external link navigation confirmations.</li>
        <li><b>Isolated Mods Webview (Fixed in v5.0.0)</b>: The Mods tab now runs in an isolated in-memory partition with Electron-identifying headers stripped, fixing Cloudflare bot-detection black screens.</li>
        <li><b>Download Location Chooser</b>: Choose custom folders when downloading files from sources.</li>
        <li><b>Automatic Extraction</b>: Handles zipped, raw, RAR, and <code>.7z</code> mod archives automatically (with packaged release fixes).</li>
      </ul>
    </details>
  </li>
  <li>
    <details>
      <summary>🎨 <b>Interface, Customization & Visuals</b></summary>
      <ul>
        <li><b>Frosted-Glass Mode</b>: Enable translucent layouts in settings with fixed background blobs and physics-based spring animations.</li>
        <li><b>Custom Theme Creator</b>: Build custom color schemes, adjusting backdrop blur, borders, fonts, and opacity.</li>
        <li><b>Canvas UI Editor (New in v5.0.0)</b>: A full live visual editor — drag, resize, and reposition elements; rename text labels; build per-element or global gradients; apply live CSS animations (pulse, float, glow, spin, gradient-shift, shimmer); edit across multiple pages with a draggable inspector panel; fully compatible with theme import/export.</li>
        <li><b>Animated Backgrounds</b>: Pulse, Grid, Wave, Ripple, and Frost Sweep animations.</li>
        <li><b>Big Picture Mode</b>: Console-style interface with full gamepad navigation, boot sounds, and monitor target selection.</li>
        <li><b>Collapsible Sidebar</b>: Collapsible folders sidebar with fixed favorites spacing and responsive layouts.</li>
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
        <li><b>Native Cloud Save Sync</b>: Sync saves directly with Google Drive, OneDrive, Dropbox, or Mediafire APIs.</li>
        <li><b>Auto Settings Sync</b>: Automatically download and import launcher settings and custom themes upon linking a sync provider.</li>
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
        <li><b>Friend Activity Bar (Improved in v5.0.0)</b>: Integrates Steam/Discord friend statuses directly in the launcher, now with colored presence dots (🔵 online, 🟢 playing, 🟡 away, 🔴 dnd, ⚪ offline) and soft glow effects.</li>
      </ul>
    </details>
  </li>
</ul>
</details>

---

## 📸 Screenshots
<img width="2000" height="1135" alt="image" src="https://github.com/user-attachments/assets/9fb3128d-0c1b-414e-b1ba-c042361a23cc" />

<img width="2000" height="1135" alt="image" src="https://github.com/user-attachments/assets/bdc76c5c-2be6-42eb-956c-f40f28bc2732" />

