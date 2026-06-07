Sail Launcher v4.2.6 Changelog

Updated quite a bit of stuff this update! Finally added those extra sorting options i promised last time and got ad blocking working in the browser. Refer [here](#website-updates) to see updates to the website and refer [here](#launcher-updates) to see updates to the launcher.

Major updates:

Added a new "developer mode" in the experimental settings tab which lets me manage and publish announcement banners directly to everyone who has the launcher open using Supabase!

Glassmorphic UI is now enabled by default for everyone! (instead of being in the experimental tab) but if you prefer the old design you can toggle the "Legacy UI" option in system settings to revert back.

Implemented an integrated ad & popup blocker for the built-in browser (sources page) so you don't get annoying pop-ups or redirect modals when browsing pages with ads.

Added advanced library sorting options and a "Favorites First" toggle so you can customize how your games are laid out.



## <a name="launcher-updates"></a>Launcher Updates

**New Features & Enhancements**

#1 Developer Mode with Remote Alerts:
Added a new "Developer Mode" checkbox in experimental settings that is password-protected using `"SailLauncherIsPeak034!"`.
Toggling it ON pops open a clean custom password modal overlay (had to build this because Electron doesn't support native `prompt` dialogs and would fail silently).
Once unlocked, it reveals a new **Alerts Manager** tab where I can write alert messages, select severity types (Info, Warning, Critical), and publish them.
Alerts show up instantly as a glassmorphic banner for everyone online, which stays sticky at the top of the scroller even when scrolling.

#2 Default Glass UI & Legacy UI Toggle:
Made the beautiful glassmorphic layout default for all users since it looks way cooler.
Added a "Legacy UI" toggle under System Settings so you can turn it off and go back to the old flat UI layout if you want.
Moved the glass translucency slider into the System Settings tab too (it automatically hides when Legacy UI is enabled).

#3 Advanced Sorting & Favorites First:
Added more sorting modes in Settings -> Library Management: Alphabetical (A-Z), Alphabetical (Z-A), Newly Added, Oldest Added, Playtime (Highest/Lowest), and Recently Played.
Steam, Epic, GOG auto-imports and manual saves now save `addedAt` timestamps so sorting works perfectly.
Added a "Favorites First" checkbox next to the sorting select (enabled by default) to keep your favorites pinned at the top under any active sorting method.

#4 Ad & Popup Blocker:
Created a network-level interceptor in main.js to block requests to major ad and tracking scripts.
Added a popup blocker inside the sources webview event listeners. If a site tries to trigger pop-unders or redirect tabs, it gets silently blocked instead of popping up the redirect confirmation box.

#5 Other Launcher Changes:
Updated discover page url to `https://sailhub.fyi/plugins` since i updated the site recently.
Bumped the launcher version to `v4.2.6` across the board (package.json, main.js, settings buttons, etc.).

## <a name="website-updates"></a>Website Updates

Updated the site recently and redirected discover tab lazy loading directly to the new plugins page at `sailhub.fyi/plugins`.

Fixed some routing on the auth pages to redirect clean URLs home.



**Full Changelog**: https://github.com/Aseoriy/Sail-Launcher/compare/4.2.5...4.2.6
