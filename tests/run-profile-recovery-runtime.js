'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { ProfileStore } = require('../accounts/profileStore');

const projectRoot = path.resolve(__dirname, '..');

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

function requestJson(url) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (error) { reject(error); }
            });
        });
        request.once('error', reject);
        request.setTimeout(1000, () => request.destroy(new Error('DevTools request timed out.')));
    });
}

async function waitForPage(port, child) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Sail exited before the recovery probe connected (${child.exitCode}).`);
        try {
            const targets = await requestJson(`http://127.0.0.1:${port}/json/list`);
            const page = targets.find(target => target.type === 'page' && /index\.html/i.test(target.url || ''));
            if (page && page.webSocketDebuggerUrl) return page;
        } catch (_) {}
        await delay(100);
    }
    throw new Error('Sail renderer did not expose a DevTools target in time.');
}

function connectDebugger(url) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.once('open', () => resolve(socket));
        socket.once('error', reject);
    });
}

function evaluate(socket, expression) {
    return new Promise((resolve, reject) => {
        const id = 1;
        const onMessage = raw => {
            const message = JSON.parse(String(raw));
            if (message.id !== id) return;
            socket.off('message', onMessage);
            if (message.error) return reject(new Error(message.error.message));
            const evaluation = message.result;
            if (evaluation && evaluation.exceptionDetails) {
                return reject(new Error(evaluation.exceptionDetails.exception && evaluation.exceptionDetails.exception.description
                    || evaluation.exceptionDetails.text || 'Renderer evaluation failed.'));
            }
            resolve(evaluation && evaluation.result && evaluation.result.value);
        };
        socket.on('message', onMessage);
        socket.send(JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true }
        }));
    });
}

function prepareFixture(tempRoot) {
    const userData = path.join(tempRoot, 'userData');
    const gameRoot = path.join(tempRoot, 'game');
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(gameRoot, { recursive: true });
    const executablePath = path.join(gameRoot, 'fixture-game.exe');
    const achievementPath = path.join(gameRoot, 'achievements.json');
    fs.writeFileSync(executablePath, 'fixture');
    fs.writeFileSync(achievementPath, JSON.stringify({
        achievements: { RECOVERY_UNLOCK: { achieved: true, unlocktime: 1710000000 } }
    }));
    const snapshot = {
        myGames: [{
            id: 'recovery-game', name: 'Recovery Game', platform: 'custom',
            tags: [], isFavorite: false, addedAt: 1710000000000, playtime: 0,
            lastPlayed: null, playtimeSessionIds: [], configSyncEntries: [],
            achievementData: {
                schemaVersion: 1, appId: '', updatedAt: 1710000000000,
                lastSteamRefreshAt: null, lastLocalScanAt: 1710000000000,
                items: [{
                    id: 'RECOVERY_UNLOCK', displayName: 'Recovery Unlock', description: '',
                    hidden: false, icon: null, iconGray: null, unlocked: true,
                    unlockTime: 1710000000000, source: 'local'
                }]
            }
        }],
        customSections: [],
        globalSettings: {
            theme: 'theme-midnight', achievementTrackingEnabled: true,
            achievementNotificationsEnabled: false
        }
    };
    const store = new ProfileStore(userData);
    store.initialize();
    store.captureActiveSnapshot(snapshot);
    store.createExecutionCapability('recovery-game', {
        executablePath,
        argv: [],
        workingDirectory: gameRoot,
        preLaunchScript: '', postLaunchScript: '', companionPath: '',
        runAsAdmin: false, highPriority: false, playDetectionPath: '', steamAppId: ''
    });
    const state = store.createLibrary('Historical Cloud Library', snapshot);
    const profile = state.profiles.find(item => item.id === state.activeProfileId);
    const historical = profile.libraries.find(item => item.id !== state.activeLibraryId);
    const libraryPath = path.join(store.root, 'profiles', profile.id, 'portable', 'libraries', `${historical.id}.json`);
    const libraryDocument = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
    libraryDocument.library.games[0].achievementData.items[0].iconPath = achievementPath;
    libraryDocument.library.games[0].achievementData.items[0].iconGrayPath = path.join(gameRoot, 'locked.png');
    fs.writeFileSync(libraryPath, `${JSON.stringify(libraryDocument, null, 2)}\n`);
    return { userData };
}

async function main() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-profile-recovery-runtime-'));
    const fixture = prepareFixture(tempRoot);
    const port = await freePort();
    const electronPath = require('electron');
    const child = spawn(electronPath, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${fixture.userData}`,
        '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox',
        projectRoot
    ], {
        cwd: projectRoot,
        env: { ...process.env, SAIL_ALLOW_MULTI_INSTANCE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    let socket;
    try {
        const page = await waitForPage(port, child);
        socket = await connectDebugger(page.webSocketDebuggerUrl);
        const report = await evaluate(socket, `(async () => {
            const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
            const ipc = require('electron').ipcRenderer;
            const originalInvoke = ipc.invoke.bind(ipc);
            const unwrap = result => {
                if (result && result.success === false) throw new Error(result.error && result.error.message || 'Account IPC failed.');
                return result && result.success === true ? result.data : result;
            };
            const deadline = Date.now() + 15000;
            while ((typeof saveToMemory !== 'function' || !globalThis.SailAchievements || !Array.isArray(myGames)) && Date.now() < deadline) {
                await delay(50);
            }
            if (typeof saveToMemory !== 'function' || !globalThis.SailAchievements || !Array.isArray(myGames)) {
                throw new Error('Renderer profile state did not become ready.');
            }
            await delay(2200);
            const counts = {};
            ipc.invoke = (channel, ...args) => {
                counts[channel] = (counts[channel] || 0) + 1;
                return originalInvoke(channel, ...args);
            };
            saveToMemory();
            await delay(5500);
            const snapshot = { myGames, customSections, globalSettings };
            const capture = unwrap(await originalInvoke('profiles-capture-active', snapshot));
            const controlPlane = unwrap(await originalInvoke('profiles-export-control-plane'));
            const cleanExport = !JSON.stringify(controlPlane).includes('iconPath')
                && !JSON.stringify(controlPlane).includes('iconGrayPath');
            const remote = JSON.parse(JSON.stringify(controlPlane));
            const remoteItem = remote.libraries.flatMap(library => library.games)
                .map(game => game.achievementData && game.achievementData.items && game.achievementData.items[0])
                .find(Boolean);
            if (!remoteItem) throw new Error('Recovery fixture achievement was not exported.');
            remoteItem.iconPath = 'C:\\\\RemoteCache\\\\unlocked.png';
            remoteItem.iconGrayPath = 'C:\\\\RemoteCache\\\\locked.png';
            const merged = unwrap(await originalInvoke('profiles-merge-control-plane', remote));
            const transfer = unwrap(await originalInvoke('profiles-create-portable-upload-transfer'));
            const userData = await originalInvoke('get-user-data');
            return {
                version: require('./package.json').version,
                userData,
                achievementSyncCalls: counts['achievements-set-library'] || 0,
                profileCaptureCalls: counts['profiles-capture-active'] || 0,
                captureSaved: capture && capture.saved === true,
                cleanExport,
                mergeLoadedGames: merged && merged.snapshot && merged.snapshot.myGames.length,
                mergeDroppedArtwork: merged && merged.diagnostics && merged.diagnostics.droppedFields
                    .filter(row => row.key === 'iconPath' || row.key === 'iconGrayPath').length,
                transferCreated: !!(transfer && transfer.capabilityId)
            };
        })()`);
        assert.equal(report.version, '5.5.0');
        assert.equal(path.resolve(report.userData), path.resolve(fixture.userData));
        assert.equal(report.achievementSyncCalls, 1);
        assert.ok(report.profileCaptureCalls >= 1);
        assert.equal(report.captureSaved, true);
        assert.equal(report.cleanExport, true);
        assert.ok(report.mergeLoadedGames >= 1);
        assert.equal(report.mergeDroppedArtwork, 2);
        assert.equal(report.transferCreated, true);
        console.log(`SAIL_PROFILE_RECOVERY_RUNTIME_OK ${JSON.stringify(report)}`);
    } catch (error) {
        console.error(`SAIL_PROFILE_RECOVERY_RUNTIME_FAILED ${error.stack || error.message}`);
        if (output.trim()) console.error(output.trim().slice(-12000));
        process.exitCode = 1;
    } finally {
        if (socket && socket.readyState === WebSocket.OPEN) socket.close();
        if (child.exitCode === null) child.kill();
        await Promise.race([
            new Promise(resolve => child.once('exit', resolve)),
            delay(5000)
        ]);
        try { fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
        catch (error) {
            console.error(`SAIL_PROFILE_RECOVERY_RUNTIME_CLEANUP_FAILED ${error.code || error.message}`);
            process.exitCode = 1;
        }
    }
}

main().catch(error => {
    console.error(`SAIL_PROFILE_RECOVERY_RUNTIME_FAILED ${error.stack || error.message}`);
    process.exitCode = 1;
});
