'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const achievementRendererSource = fs.readFileSync(path.join(root, 'ui', 'achievements.js'), 'utf8');
const syncSource = fs.readFileSync(path.join(root, 'sync', 'syncV2.js'), 'utf8');
const profileSource = fs.readFileSync(path.join(root, 'accounts', 'profileStore.js'), 'utf8');
const capabilitySource = fs.readFileSync(path.join(root, 'security', 'capabilityStore.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const SafeDom = require('../ui/safeDom');

test('v5.4 packages and registers the achievement subsystem', () => {
    assert.equal(packageJson.version, '5.4.1');
    assert.equal(packageJson.build.artifactName, 'Sail-Launcher-Setup-${version}.${ext}');
    assert.ok(packageJson.build.files.includes('achievements/**/*'));
    assert.match(packageJson.scripts.check, /achievements\/achievementService\.js/);
    assert.match(mainSource, /registerAchievementIpc/);
    assert.match(mainSource, /Notification/);
    assert.match(mainSource, /achievementService\.dispose\(\)/);
});

test('renderer exposes the achievements hub, game panel, controls, and notification setting', () => {
    assert.match(rendererSource, /id="tabAchievements"/);
    assert.match(rendererSource, /id="achievementsView"/);
    assert.match(rendererSource, /id="gpAchievementsPanel"/);
    assert.match(rendererSource, /id="achievementTrackingToggle"/);
    assert.match(rendererSource, /id="achievementCardBadgesToggle"/);
    assert.match(rendererSource, /id="achievementNotificationsToggle"/);
    assert.match(rendererSource, /achievementTrackingEnabled:\s*true/);
    assert.match(rendererSource, /achievementCardBadgesEnabled:\s*true/);
    assert.match(rendererSource, /achievementNotificationsEnabled:\s*true/);
    assert.match(rendererSource, /SailAchievements\.initialize/);
    assert.match(achievementRendererSource, /achievements-import-steam/);
    assert.match(achievementRendererSource, /achievements-refresh-local/);
    assert.match(achievementRendererSource, /achievementToastStack/);
    assert.match(achievementRendererSource, /expandedGamePanels/);
    assert.match(achievementRendererSource, /official Steam titles and artwork/);
    assert.match(achievementRendererSource, /achievements-import-steam-schema/);
});

test('library cards keep their cover clipping while hovering', () => {
    assert.match(rendererSource, /#gameGrid:not\(\.list-view\) \.game-card \.card-banner,[\s\S]{0,300}border-radius: inherit !important/);
    assert.match(rendererSource, /#gameGrid:not\(\.list-view\) \.game-card \{[\s\S]{0,300}overflow: clip;[\s\S]{0,100}isolation: isolate;/);
    assert.doesNotMatch(rendererSource, /perspective\(1100px\)|rotateX\(var\(--card-rx/);
});

test('initial achievement enrichment retries incomplete caches and admits Steam-owned artwork hosts', () => {
    assert.match(achievementRendererSource, /steamEnrichmentAttempts\.has\(key\)[\s\S]{0,120}data && data\.items\.length && !missingMetadataCount\(data\)/);
    assert.doesNotMatch(achievementRendererSource, /lastRefresh > Date\.now\(\) - 7 \* 24 \* 60 \* 60 \* 1000/);
    assert.match(achievementRendererSource, /games: targets\.map/);
    assert.equal(
        SafeDom.safeImageUrl('https://shared.fastly.steamstatic.com/community_assets/images/apps/3489700/suit.jpg', { allowSteam: true }),
        'https://shared.fastly.steamstatic.com/community_assets/images/apps/3489700/suit.jpg'
    );
    assert.equal(
        SafeDom.safeImageUrl('https://future-cdn.steamstatic.com/community_assets/icon.jpg', { allowSteam: true }),
        'https://future-cdn.steamstatic.com/community_assets/icon.jpg'
    );
    assert.equal(
        SafeDom.safeImageUrl('https://shared.fastly.steamstatic.com.evil.test/community_assets/icon.jpg', { allowSteam: true }),
        ''
    );
});

test('achievement tracking and card badges can be disabled independently', () => {
    const serviceSource = fs.readFileSync(path.join(root, 'achievements', 'achievementService.js'), 'utf8');
    assert.match(serviceSource, /this\.trackingEnabled = true/);
    assert.match(serviceSource, /if \(!this\.trackingEnabled\) return \{ updates: \[\], errors: \[\], disabled: true \}/);
    assert.match(achievementRendererSource, /achievementCardBadgesEnabled === false/);
    assert.match(achievementRendererSource, /setTracking/);
});

test('editing a game preserves achievement progress and device source mappings', () => {
    assert.match(rendererSource, /achievementAppIdChanged/);
    assert.match(rendererSource, /achievementData:\s*editingIndex === -1 \|\| achievementAppIdChanged \? undefined : myGames\[editingIndex\]\.achievementData/);
    assert.match(rendererSource, /achievementSources:\s*editingIndex === -1 \? undefined : myGames\[editingIndex\]\.achievementSources/);
});

test('portable and profile sync keep progress while treating source paths as device-only', () => {
    assert.match(syncSource, /createPortableSnapshot/);
    assert.match(profileSource, /capability\.kind === 'achievement-file'/);
    assert.match(capabilitySource, /game\.achievementSources/);
    assert.match(capabilitySource, /adoptTrustedLocalFilesystem\(scope, kind/);
    assert.match(profileSource, /mergeAchievementData/);
    assert.match(rendererSource, /profiles-capture-active/);
    assert.match(achievementRendererSource, /achievements-pick-source/);
    assert.doesNotMatch(achievementRendererSource, /picked\.path/);
    assert.match(rendererSource, /profiles-import-portable-transfer/);
});

test('achievement tracker remains read-only toward external game data', () => {
    const sources = [
        fs.readFileSync(path.join(root, 'achievements', 'achievementService.js'), 'utf8'),
        fs.readFileSync(path.join(root, 'achievements', 'achievementDiscovery.js'), 'utf8'),
        fs.readFileSync(path.join(root, 'achievements', 'achievementParsers.js'), 'utf8')
    ].join('\n');
    assert.doesNotMatch(sources, /writeFile|appendFile|unlinkSync|rmSync|renameSync/);
    assert.doesNotMatch(sources, /properties:\s*\['openFile',\s*'openDirectory'\]/);
});
