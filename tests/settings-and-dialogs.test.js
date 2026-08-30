'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { normalizeSettings } = require('../maintenance/settings');

test('maintenance settings normalization preserves object identity and toggle changes', () => {
    const saved = { hideInformationIssues: false };
    const normalized = normalizeSettings(saved, { hideInformationIssues: false, maxConcurrentScans: 2, ignorePatterns: [] });
    assert.equal(normalized, saved);
    normalized.hideInformationIssues = true;
    assert.equal(saved.hideInformationIssues, true);
    assert.deepEqual(saved.ignorePatterns, []);
});

test('launcher confirmations use the themed asynchronous dialog', () => {
    const root = path.join(__dirname, '..');
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const dialogs = fs.readFileSync(path.join(root, 'ui', 'dialogs.js'), 'utf8');
    const maintenance = fs.readFileSync(path.join(root, 'maintenance', 'renderer.js'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.match(index, /ui\/dialogs\.css/);
    assert.match(index, /ui\/dialogs\.js/);
    assert.doesNotMatch(index, /\bconfirm\s*\(/);
    assert.doesNotMatch(maintenance, /\bconfirm\s*\(/);
    assert.match(index, /sailConfirm\s*\(/);
    assert.match(index, /pendingCloudOAuthDialogKey/);
    assert.match(index, /dismissSailAlert\(dialogKey\)/);
    assert.match(index, /cloudProviderDisplayName/);
    assert.match(index, /Connection successful/);
    assert.match(index, /Connection failed/);
    assert.match(index, /safeSyncErrorMessage\(result && result\.error/);
    assert.match(dialogs, /options\.dialogKey/);
    assert.match(dialogs, /window\.dismissSailAlert/);
    assert.ok(packageJson.build.files.includes('ui/**/*'));
});

test('removed download providers are absent from the source registry and IPC surface', () => {
    const root = path.join(__dirname, '..');
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    assert.doesNotMatch(index, /\bonlinefix\s*:\s*\{/i);
    assert.doesNotMatch(index, /\bdodi\s*:\s*\{/i);
    assert.match(index, /const dlEnabled = \{ steamgg: true, fitgirl: true, steamrip: true \}/);
    assert.doesNotMatch(main, /ipcMain\.handle\(['"]resolve-onlinefix['"]/i);
});

test('SteamRIP stays available when no debrid service is connected', () => {
    const root = path.join(__dirname, '..');
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const sourceStart = index.indexOf('steamrip: {');
    const sourceEnd = index.indexOf('const dlEnabled', sourceStart);
    const steamripSource = index.slice(sourceStart, sourceEnd);

    assert.ok(sourceStart >= 0 && sourceEnd > sourceStart);
    assert.doesNotMatch(steamripSource, /requiresDebrid/);
    assert.doesNotMatch(index, /dlEnabled\.steamrip\s*=\s*false/);
    assert.doesNotMatch(index, /steamripLockHint|SteamRIP\s+requires a connected debrid service/i);
    assert.match(index, /<b>SteamRIP works without debrid\.<\/b>/);
    assert.match(index, /const eligible = id => !!DL_SOURCES\[id\]/);
});

test('game executable Browse opens immediately and Save applies its opaque selection', () => {
    const root = path.join(__dirname, '..');
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const browseStart = index.indexOf("document.getElementById('browseExeBtn').addEventListener");
    const browseEnd = index.indexOf("document.getElementById('browseShortcutIconBtn')", browseStart);
    const browseBinding = index.slice(browseStart, browseEnd);
    const saveStart = index.indexOf("document.getElementById('saveBtn').addEventListener");
    const saveEnd = index.indexOf('window.editGame = function', saveStart);
    const saveBinding = index.slice(saveStart, saveEnd);

    assert.ok(browseStart >= 0 && browseEnd > browseStart);
    assert.match(browseBinding, /invokeAccount\('authority-select-executable', \{\}\)/);
    assert.match(browseBinding, /localAuthorityDraft\.executableSelectionId = selection\.selectionId/);
    assert.doesNotMatch(browseBinding, /Selection requested for Save/);
    assert.match(saveBinding, /isSteam && !localAuthorityDraft\.executableSelectionId/);
    assert.match(saveBinding, /baseSelectionId: localAuthorityDraft\.executableSelectionId/);
});

test('accent outline affects interactive states without overriding resting buttons', () => {
    const root = path.join(__dirname, '..');
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const maintenance = fs.readFileSync(path.join(root, 'maintenance', 'renderer.js'), 'utf8');
    const maintenanceCss = fs.readFileSync(path.join(root, 'maintenance', 'maintenance.css'), 'utf8');
    assert.match(index, /body\.dropdown-accent-outline button:not\([^\n]+:hover/);
    assert.match(index, /body\.dropdown-accent-outline button:not\([^\n]+:focus-visible/);
    const outlineComment = index.indexOf('Outline mode never changes a button');
    const outlineRule = index.slice(outlineComment, index.indexOf('{', outlineComment));
    const selectors = outlineRule.match(/body\.dropdown-accent-outline button[^,\n]+/g) || [];
    assert.ok(selectors.length >= 4);
    selectors.forEach(selector => assert.match(selector, /:(hover|focus-visible|active)|\[aria-pressed="true"\]/));
    assert.match(index, /Button &amp; dropdown highlight style/);
    assert.match(index, /browseBtn\.classList\.add\('save-scan-loading'\)/);
    assert.match(maintenance, /button\.dataset\.saveRescan = gameId/);
    assert.match(maintenance, /Scanning Save Folders/);
    assert.match(maintenanceCss, /@keyframes maintenanceSaveScanSpin/);
});

test('switching themes cannot retain previous canvas-editor appearance overrides', () => {
    const root = path.join(__dirname, '..');
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(index, /globalSettings\.uiCustom = ct\.uiCustom \? _clone\(ct\.uiCustom\) : \{\};/);
    assert.match(index, /globalSettings\.uiAppBg = ct\.uiAppBg !== undefined \? ct\.uiAppBg : '';/);
    assert.match(index, /globalSettings\.uiAppBgStore = ct\.uiAppBgStore \? _clone\(ct\.uiAppBgStore\) : null;/);
    assert.match(index, /globalSettings\.uiAccent = ct\.uiAccent !== undefined \? ct\.uiAccent : '';/);
    assert.match(index, /document\.body\.className = SafeDom\.safeThemeId\(themeId\) \+ ' ' \+ classesToKeep\.join\(' '\)[\s\S]{0,500}globalSettings\.uiCustom = \{\};[\s\S]{0,200}globalSettings\.uiAppBg = '';[\s\S]{0,200}globalSettings\.uiAppBgStore = null;[\s\S]{0,200}globalSettings\.uiAccent = '';[\s\S]{0,200}applyUiCustom\(\);[\s\S]{0,100}applyUiAccent\(\);/);
    assert.match(index, /function uieSyncCurrentThemeOverrides\(\)[\s\S]{0,1500}ct\.uiCustom = clone\(globalSettings\.uiCustom\)[\s\S]{0,1000}ct\.uiAccent = globalSettings\.uiAccent/);
    assert.match(index, /uieSyncCurrentThemeOverrides\(\); saveToMemory\(\);/);
    assert.match(index, /body\.glassmorphic-mode\.disable-translucency \{ background: ' \+ appBg \+ ' !important;/);
});

test('v5.5.0 sidebar, announcements, and forced reinstall wiring are present', () => {
    const root = path.join(__dirname, '..');
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(packageJson.version, '5.5.0');
    assert.equal(packageJson.dependencies['@supabase/supabase-js'], '2.109.0');
    assert.match(index, /grid-template-columns:\s*280px 1fr/);
    assert.match(index, /<div class="settings-tabs">/);
    assert.doesNotMatch(index, /settingsCategoryTrigger|settingsCategoryMenu|settings-pane-card/);
    assert.match(index, /class="sidebar-page-nav"/);
    assert.match(index, /class="sidebar-page-link active-tab" id="tabLibrary"/);
    assert.match(index, /MAIN SIDEBAR — structured page rail/);
    assert.match(index, /sidebar\.collapsed \.sidebar-page-label/);
    assert.match(index, /Reinstall latest release/);
    assert.match(index, /forceInstall:\s*true/);
    assert.match(index, /require\('\.\/package\.json'\)\.version/);
    assert.match(index, /account-alert-admin-state/);
    assert.match(index, /account-publish-alert/);
    assert.match(index, /Use your signed-in Sail Hub account/);
    assert.doesNotMatch(index, /alertAdminPassword|signInAlertAdmin|alertSupabase\.auth\.signInWithPassword/);
    assert.match(index, /persistSession:\s*false/);
    assert.doesNotMatch(index, /id="adminServiceRoleKeyInput"/);
    assert.doesNotMatch(index, /service_role/i);
    assert.match(index, /message\.textContent = String\(announcement\.message/);
});

test('library polish keeps sorting and filtering on the existing library state', () => {
    const root = path.join(__dirname, '..');
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const sortValues = ['alphabetical', 'alphabetical-desc', 'newest', 'oldest', 'playtime', 'playtime-asc', 'recent'];
    const filterValues = ['ALL', 'FAVORITES', 'RECENT', 'UNPLAYED', 'STEAM', 'CUSTOM'];

    assert.match(index, /id="librarySortOrder"/);
    assert.match(index, /id="libraryResultCount"/);
    assert.match(index, /id="libraryEmptyState"/);
    sortValues.forEach(value => assert.match(index, new RegExp(`value="${value}"`)));
    filterValues.forEach(value => assert.match(index, new RegExp(`value="${value}"`)));
    assert.match(index, /function setLibrarySortOrder\(value\)/);
    assert.match(index, /globalSettings\.sortOrder = LIBRARY_SORT_ORDER_VALUES/);
    assert.match(index, /function setLibraryToolbarFilter\(filterValue\)/);
    assert.match(index, /filterBySection\(sectionId, value\)/);
    assert.match(index, /Showing \$\{visibleCount\} of \$\{totalCount\}/);
    assert.match(index, /Your library is empty/);
    assert.match(index, /No games match your search and filters/);
    assert.match(index, /clearLibrarySearchBtn/);
    assert.match(index, /resetLibraryFiltersBtn/);
});
