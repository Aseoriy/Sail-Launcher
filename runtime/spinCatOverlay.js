'use strict';

// The "don't press this" button in Settings > Experimental. A small transparent window sits on the desktop
// itself, above everything, so minimising Sail does not make the cat go away. It ignores the mouse and never takes
// focus. The page inside it is a self-contained data: URL with no network access and no Node.js.

const HOLD_MS = 10000;
const POOF_MS = 1500;
const WINDOW_SIZE = 640;

function buildOverlayHtml({ holdMs = HOLD_MS, poofMs = POOF_MS, reduceMotion = false } = {}) {
    const puffs = Array.from({ length: 12 }, (_, i) => {
        const angle = (i / 12) * Math.PI * 2;
        const dist = 150 + (i % 3) * 38;
        return `<i style="--dx:${Math.round(Math.cos(angle) * dist)}px;--dy:${Math.round(Math.sin(angle) * dist)}px;--s:${(1 + (i % 4) * 0.25).toFixed(2)}"></i>`;
    }).join('');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Sail</title>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;user-select:none}
.stage{position:fixed;inset:0;display:grid;place-items:center}
.pop{width:300px;height:300px;animation:pop .35s cubic-bezier(.2,1.6,.4,1) both}
.spin{width:100%;height:100%;animation:${reduceMotion ? 'none' : 'spin .6s linear infinite'}}
.mouth{transform-origin:150px 196px;animation:${reduceMotion ? 'none' : 'talk .3s ease-in-out infinite alternate'}}
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
@keyframes talk{from{transform:scaleY(.45)}to{transform:scaleY(1.05)}}
@keyframes vanish{to{transform:scale(0) rotate(180deg);opacity:0}}
@keyframes puff{0%{opacity:.95;transform:translate(0,0) scale(.3)}70%{opacity:.8}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(calc(var(--s)*1.7))}}
@keyframes word{0%{transform:translateX(-50%) scale(0)}25%{transform:translateX(-50%) scale(1.15)}100%{transform:translateX(-50%) translateY(-40px) scale(1);opacity:0}}
</style></head>
<body><div class="stage" id="stage">
<div class="pop"><div class="spin">
<svg viewBox="0 0 300 300" width="100%" height="100%" aria-hidden="true">
<polygon points="55,125 62,32 130,82" fill="#f0a23c"/><polygon points="245,125 238,32 170,82" fill="#f0a23c"/>
<polygon points="68,112 72,56 112,88" fill="#f7a8b8"/><polygon points="232,112 228,56 188,88" fill="#f7a8b8"/>
<ellipse cx="150" cy="170" rx="108" ry="98" fill="#f6b852"/>
<path d="M150 74v26M122 78l5 22M178 78l-5 22" stroke="#d98a24" stroke-width="7" stroke-linecap="round"/>
<ellipse cx="108" cy="152" rx="23" ry="27" fill="#fff"/><ellipse cx="192" cy="152" rx="23" ry="27" fill="#fff"/>
<circle cx="112" cy="156" r="12" fill="#2b2118"/><circle cx="188" cy="156" r="12" fill="#2b2118"/>
<circle cx="116" cy="151" r="4" fill="#fff"/><circle cx="192" cy="151" r="4" fill="#fff"/>
<ellipse cx="150" cy="186" rx="9" ry="6" fill="#e8738c"/>
<g class="mouth"><ellipse cx="150" cy="212" rx="27" ry="24" fill="#5b1f2d"/><ellipse cx="150" cy="226" rx="16" ry="9" fill="#e8738c"/></g>
<path d="M62 186l-40-8M62 200l-42 6M238 186l40-8M238 200l42 6" stroke="#8a5a1d" stroke-width="3" stroke-linecap="round"/>
</svg></div></div>
<div class="puffs">${puffs}</div><div class="word">poof!</div>
</div>
<script>
setTimeout(function(){document.getElementById('stage').classList.add('gone')},${holdMs});
</script></body></html>`;
}

function createSpinCatOverlay({ BrowserWindow, screen, getAnchorWindow = () => null, holdMs = HOLD_MS, poofMs = POOF_MS,
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
        const html = buildOverlayHtml({ holdMs, poofMs, reduceMotion });
        Promise.resolve(win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))).catch(finish);
        return true;
    }

    return { show, isActive: () => active !== null };
}

module.exports = { buildOverlayHtml, createSpinCatOverlay, HOLD_MS, POOF_MS };
