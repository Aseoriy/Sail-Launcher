'use strict';

// The "don't press this" button in Settings > Experimental. A small transparent window sits on the desktop
// itself, above everything, so minimising Sail does not make the cat go away. It ignores the mouse and never takes
// focus. The page inside it is a self-contained data: URL with no network access and no Node.js.

const fs = require('node:fs');
const path = require('node:path');

const HOLD_MS = 10000;
const POOF_MS = 1500;
const WINDOW_SIZE = 640;

const IMAGE_TYPES = { '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// The picture is a file next to the launcher's UI code (ui/assets/spin-cat.*), read once and handed to the page as
// a data: URL so the overlay never needs file or network access. Returns null when there is no usable image.
function loadCatImage(dir) {
    for (const [extension, mime] of Object.entries(IMAGE_TYPES)) {
        const file = path.join(dir, 'spin-cat' + extension);
        try {
            const stat = fs.statSync(file);
            if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) continue;
            return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
        } catch (_) { /* try the next type */ }
    }
    return null;
}

function buildOverlayHtml({ holdMs = HOLD_MS, poofMs = POOF_MS, reduceMotion = false, image = '' } = {}) {
    // An animated picture (a GIF) already spins on its own, so it is not turned a second time.
    const animated = image.startsWith('data:image/gif');
    const puffs = Array.from({ length: 12 }, (_, i) => {
        const angle = (i / 12) * Math.PI * 2;
        const dist = 150 + (i % 3) * 38;
        return `<i style="--dx:${Math.round(Math.cos(angle) * dist)}px;--dy:${Math.round(Math.sin(angle) * dist)}px;--s:${(1 + (i % 4) * 0.25).toFixed(2)}"></i>`;
    }).join('');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Sail</title>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;user-select:none}
.stage{position:fixed;inset:0;display:grid;place-items:center}
.pop{width:300px;height:300px;animation:pop .35s cubic-bezier(.2,1.6,.4,1) both}
.cat{display:block;width:100%;height:100%;object-fit:contain;-webkit-user-drag:none}
.spin{width:100%;height:100%;animation:${reduceMotion || animated ? 'none' : 'spin .6s linear infinite'}}
.gone .pop{animation:vanish .22s ease-in forwards}
.puffs{position:fixed;left:50%;top:50%;width:0;height:0}
.puffs i{position:absolute;left:-45px;top:-45px;width:90px;height:90px;border-radius:50%;opacity:0;
background:radial-gradient(circle at 35% 35%,#fff,#e6e9ef 60%,#c5cad6);transform:scale(.2)}
.gone .puffs i{animation:puff ${poofMs}ms ease-out forwards}
.word{position:fixed;left:50%;top:50%;margin:-150px 0 0 0;transform:translateX(-50%) scale(0);font:800 54px/1 system-ui,sans-serif;
color:#fff;letter-spacing:2px;-webkit-text-stroke:2px #5b3fd6;paint-order:stroke fill;text-shadow:0 3px 0 #5b3fd6,0 0 22px rgba(122,92,255,.8)}
.gone .word{animation:word ${poofMs}ms ease-out .1s forwards}
@keyframes pop{from{transform:scale(0)}to{transform:scale(1)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes vanish{to{transform:scale(0) rotate(180deg);opacity:0}}
@keyframes puff{0%{opacity:.95;transform:translate(0,0) scale(.3)}70%{opacity:.8}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(calc(var(--s)*1.7))}}
@keyframes word{0%{transform:translateX(-50%) scale(0)}25%{transform:translateX(-50%) scale(1.15)}100%{transform:translateX(-50%) translateY(-40px) scale(1);opacity:0}}
</style></head>
<body><div class="stage" id="stage">
<div class="pop"><div class="spin">
<img class="cat" alt="" src="${image}"></div></div>
<div class="puffs">${puffs}</div><div class="word">poof!</div>
</div>
<script>
setTimeout(function(){document.getElementById('stage').classList.add('gone')},${holdMs});
</script></body></html>`;
}

function createSpinCatOverlay({ BrowserWindow, screen, imageDir, getAnchorWindow = () => null, holdMs = HOLD_MS, poofMs = POOF_MS,
    setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let active = null;

    function targetDisplay() {
        const anchor = getAnchorWindow();
        try {
            if (anchor && !anchor.isDestroyed() && !anchor.isMinimized()) return screen.getDisplayMatching(anchor.getBounds());
        } catch (_) { /* fall through to the primary display */ }
        return screen.getPrimaryDisplay();
    }

    function show({ reduceMotion = false } = {}) {
        if (active) return false;
        const image = loadCatImage(imageDir);
        if (!image) return false;
        const area = targetDisplay().workArea;
        const size = Math.min(WINDOW_SIZE, area.width, area.height);
        const win = new BrowserWindow({
            width: size, height: size,
            x: Math.round(area.x + (area.width - size) / 2), y: Math.round(area.y + (area.height - size) / 2),
            frame: false, transparent: true, hasShadow: false, resizable: false, movable: false,
            minimizable: false, maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true, show: false,
            backgroundColor: '#00000000',
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
                partition: 'sail-spin-cat', backgroundThrottling: false, spellcheck: false }
        });
        const state = { win, timer: null };
        active = state;
        const finish = () => {
            if (active !== state) return;
            active = null;
            if (state.timer) clearTimer(state.timer);
            try { if (!win.isDestroyed()) win.destroy(); } catch (_) { /* already gone */ }
        };
        win.setIgnoreMouseEvents(true);
        win.setAlwaysOnTop(true, 'screen-saver');
        try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) { /* not supported everywhere */ }
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('will-navigate', event => event.preventDefault());
        win.once('closed', () => { if (active === state) { active = null; if (state.timer) clearTimer(state.timer); } });
        win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); });
        state.timer = setTimer(finish, holdMs + poofMs + 1500);
        const html = buildOverlayHtml({ holdMs, poofMs, reduceMotion, image });
        Promise.resolve(win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))).catch(finish);
        return true;
    }

    return { show, isActive: () => active !== null };
}

module.exports = { buildOverlayHtml, createSpinCatOverlay, loadCatImage, HOLD_MS, POOF_MS };
