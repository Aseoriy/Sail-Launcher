'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { privateDirectory, privateRead, save, scopeKey } = require('./proton/manager');
const { fileIdentity, identityMatches } = require('../security/capabilityStore');
const discovery = require('./linuxGameDiscovery');
const native = require('./native/protocol');
const { installer, discover } = require('./proton/prerequisites');
const ACTIVE = new Set(['downloading', 'extracting', 'reviewing', 'publishing']);
const safeError = error => String(error.message || error).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);

class LinuxDownloads {
    constructor({ root, defaultRoot, getStore, getManager, registry, work, activeDownloads, dialog, authorize, resolveExecution, metadata, emit, browserResolve = null, removeDirectory = null, resolveDirect = null, browserDownload = null }) {
        Object.assign(this, { root, defaultRoot, getStore, getManager, registry, work, activeDownloads, dialog, authorize, resolveExecution, metadata, emit, browserResolve, removeDirectory, resolveDirect, browserDownload });
        this.operations = new Map(); this.reviews = new Set(); this.records = new Map(); this.initialized = false;
    }
    initialize() {
        if (this.initialized) return;
        privateDirectory(this.root, true);
        const files = fs.readdirSync(this.root); if (files.length > 256) throw Error('Too many retained Linux download jobs.');
        for (const name of files) {
            if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
            const record = JSON.parse(privateRead(path.join(this.root, name), 128 * 1024));
            if (record.protocol !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(record.id)
                || typeof record.gameName !== 'string' || record.gameName.length > 240 || typeof record.folder !== 'string'
                || !path.isAbsolute(record.folder) || !record.folderIdentity || typeof record.scope?.profileId !== 'string'
                || typeof record.scope?.libraryId !== 'string' || typeof record.scope?.gameId !== 'string'
                || !['downloading', 'paused', 'extracting', 'reviewing', 'publishing', 'saved', 'installation-required', 'installing', 'ready', 'interrupted', 'failed', 'canceled'].includes(record.phase)) throw Error('A retained Linux download record needs repair. Existing files were kept.');
            if (this.recordName(record.id) !== name) throw Error('A download record has the wrong identity.');
            this.records.set(record.id, record);
            if (record.phase === 'publishing' && typeof record.finalFolder === 'string' && path.isAbsolute(record.finalFolder)) {
                try {
                    if (fs.realpathSync(record.finalFolder) === record.finalFolder && identityMatches({ ...record.folderIdentity, realPath: record.finalFolder }, fileIdentity(record.finalFolder, 'directory'))) {
                        record.folder = record.finalFolder; record.published = true; record.phase = 'saved'; this.write(record);
                    }
                } catch (_) { /* A renamed or missing tree cannot be adopted. */ }
            }
            // The job registry lives only for this session, so a paused transfer cannot continue after a restart.
            if (record.phase === 'paused') { record.phase = 'interrupted'; record.error = 'This download was paused when Sail closed. Its files were kept; remove it and start the download again.'; this.write(record); }
            if (ACTIVE.has(record.phase)) { record.phase = 'interrupted'; record.error = 'Download preparation was interrupted. Existing files were kept; import the saved archive or start a new download.'; this.write(record); }
        }
        this.initialized = true;
    }
    recordName(id) { return crypto.createHash('sha256').update(id).digest('hex') + '.json'; }
    write(record) {
        privateDirectory(this.root, true);
        if (!this.records.has(record.id) && this.records.size >= 256) throw Error('Too many retained Linux download jobs.');
        record.updatedAt = Date.now(); save(path.join(this.root, this.recordName(record.id)), JSON.stringify(record) + '\n'); this.records.set(record.id, record);
    }
    scope(gameId = 'launcher-device') {
        const current = gameId === 'launcher-device' ? this.getStore().activeScope() : this.getStore().authorityScope(gameId);
        return { profileId: current.profileId, libraryId: current.libraryId, gameId: String(gameId) };
    }
    sameScope(record, gameId = record.scope.gameId) {
        if (!isDeepStrictEqual(record.scope, this.scope(gameId))) throw Error('The active profile or library changed. Reopen this download from its original library.');
    }
    validateFolder(record) {
        if (fs.realpathSync(record.folder) !== record.folder || !identityMatches(record.folderIdentity, fileIdentity(record.folder, 'directory'))) throw Error('The downloaded game folder changed. Existing files were kept.');
    }
    pendingBindings() {
        return [...this.operations.values(), ...[...this.reviews].map(id => this.records.get(id)).filter(Boolean)].map(record => ({ provider: 'linux-native', gameId: record.scope.gameId,
            libraryKey: `${record.scope.profileId}:${record.scope.libraryId}` }));
    }
    forGame(gameId) {
        this.initialize(); const scope = this.scope(gameId);
        return [...this.records.values()].filter(record => isDeepStrictEqual(record.scope, scope)).sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
    }
    status(gameId) {
        const record = this.forGame(gameId); if (!record) return { available: false };
        let installation = null;
        if (record.phase === 'installing') {
            installation = this.getManager()?.installations.status(record.scope);
            if (!installation || installation.id !== record.installationId) {
                record.phase = 'interrupted'; record.error = 'This game’s installation job changed. Review its setup again.'; this.write(record); installation = null;
            }
            if (installation && !['checking', 'starting', 'running', 'waiting', 'tracking-lost'].includes(installation.phase)) {
                record.phase = installation.phase === 'completed' ? 'installation-required' : 'interrupted';
                if (installation.phase === 'completed' && record.installationType === 'prerequisites') {
                    try {
                        this.validateFolder(record);
                        const saved = this.getStore().localExecutionSetup(gameId).details;
                        if (!identityMatches(record.approvedGame, saved.executableIdentity) || this.getStore().authorityStatus(gameId).execution.state !== 'active') throw Error('Launch setup changed.');
                        discovery.validate({ executable: saved.executableIdentity, cwd: saved.workingDirectoryIdentity, backend: 'proton-umu', root: record.folder }, this.getManager());
                        this.getManager().runtime(saved.linuxRuntime.runtimeId); record.phase = 'ready';
                    } catch (_) { record.phase = 'installation-required'; }
                }
                record.error = installation.phase === 'completed' ? '' : installation.error || 'Installation stopped. Partially installed files were kept.'; this.write(record);
            }
        }
        // A separate status reader must not consume the completion evidence
        // before the renderer can offer the installed executable.
        if (!installation && record.installationId) {
            const observed = this.getManager()?.installations.status(record.scope);
            if (observed?.id === record.installationId) installation = observed;
        }
        return { available: true, id: record.id, phase: record.phase, gameId, error: record.error || '', installation,
            ready: record.phase === 'ready', detail: record.phase === 'ready' ? 'Launch setup saved.'
                : record.phase === 'installing' ? 'Windows installation is running in this game’s Proton environment.'
                : 'Scan the downloaded folder and this game’s Windows environment to finish launch setup.' };
    }
    list() {
        this.initialize(); const scope = this.scope();
        const games = new Set(this.getStore().loadActiveSnapshot().myGames.map(game => String(game.id)));
        return { scope, downloads: [...this.records.values()].filter(record => record.scope.profileId === scope.profileId && record.scope.libraryId === scope.libraryId)
            .map(record => record.scope.gameId === 'launcher-device' || !games.has(record.scope.gameId) ? { id: record.id, phase: games.has(record.scope.gameId) ? record.phase : record.published ? 'saved' : record.phase, gameName: record.gameName, error: record.error || '', canAdopt: record.published === true }
                : { ...this.status(record.scope.gameId), gameName: record.gameName }) };
    }
    async adopt(event, { id }) {
        this.initialize(); const record = this.records.get(id);
        if (!record || record.published !== true || this.operations.has(id)) throw Error('This download is not ready to add to the library.');
        if (record.scope.gameId !== 'launcher-device') {
            const active = this.scope();
            if (active.profileId !== record.scope.profileId || active.libraryId !== record.scope.libraryId
                || this.getStore().loadActiveSnapshot().myGames.some(game => String(game.id) === record.scope.gameId)) throw Error('This download is already in a library.');
            record.scope = active; this.write(record);
        }
        this.sameScope(record); this.validateFolder(record); this.authorize(event);
        // A crash between metadata capture and the job update must not create
        // a duplicate game for an already recorded owned installation folder.
        const store = this.getStore(), current = store.loadActiveSnapshot();
        const existing = current.myGames.find(game => game.source === 'sail-download' && store.capabilityStore.latest('filesystem', store.authorityScope(game.id),
            item => item.details?.kind === 'game-install' && item.details.rootPath === record.folder));
        const metadata = await this.metadata(record.gameName, record.sourceId).catch(() => null);
        this.sameScope(record); this.validateFolder(record); this.authorize(event);
        const result = existing ? { gameId: existing.id } : store.registerDownloadedGameProposal({ gameName: record.gameName, folderPath: record.folder,
            sourceId: record.sourceId, steamAppId: metadata?.steamAppId });
        record.scope = this.scope(result.gameId); record.phase = 'installation-required'; this.write(record);
        const configured = await this.configure(event, { gameId: String(result.gameId) });
        return { ...configured, state: store.getState(), snapshot: store.loadActiveSnapshot() };
    }
    // Removes an unfinished (failed, interrupted or stopped) download and the files Sail kept for it.
    async discard(event, { id }) {
        this.initialize(); const record = this.records.get(id);
        if (!record || this.operations.has(id) || record.published === true || !['failed', 'canceled', 'interrupted'].includes(record.phase)) throw Error('Only unfinished downloads can be removed.');
        this.authorize(event); this.sameScope(record);
        if (fs.existsSync(record.folder)) {
            this.validateFolder(record);
            if (typeof this.removeDirectory !== 'function') throw Error('Removing downloads is unavailable.');
            await this.removeDirectory(record.folder);
        }
        fs.rmSync(path.join(this.root, this.recordName(id)), { force: true }); this.records.delete(id);
        return true;
    }
    // Uninstall: nothing may still be downloading into or reviewing this game's folder.
    assertIdleForGame(gameId) {
        this.initialize(); const scope = this.scope(gameId);
        for (const record of [...this.operations.values(), ...[...this.reviews].map(id => this.records.get(id))]) {
            if (record && isDeepStrictEqual(record.scope, scope)) throw Error('Wait for this game’s download or setup to finish before uninstalling it.');
        }
    }
    // After an uninstall the retained download record would point at a removed folder.
    forgetGame(gameId) {
        this.initialize(); const scope = this.scope(gameId); let removed = 0;
        for (const record of [...this.records.values()]) {
            if (!isDeepStrictEqual(record.scope, scope) || this.operations.has(record.id)) continue;
            fs.rmSync(path.join(this.root, this.recordName(record.id)), { force: true }); this.records.delete(record.id); removed++;
        }
        return removed;
    }
    // Stops the current transfer but keeps the job, its folder and the partial file for resume.
    async pause(event, id) {
        const record = this.operations.get(id), controller = this.activeDownloads.get(id);
        if (!record || !controller || record.phase !== 'downloading') throw Error('Only a download that is transferring can be paused.');
        if (!record.pausable) throw Error('This part can’t be paused: archive imports and hosts that download through your browser run to the end. Cancel it or let it finish.');
        this.authorize(event); this.sameScope(record);
        controller.paused = true;
        try { controller.job.activeOperation?.stop?.(); } catch (_) { /* The transfer ends on its own. */ }
        await Promise.race([controller.settled, new Promise(resolve => setTimeout(resolve, 15000))]);
        return this.records.get(id)?.phase === 'paused';
    }
    // Cancelling a paused download leaves an unfinished record the person can remove.
    cancelPaused(id) {
        const record = this.records.get(id);
        if (!record || record.phase !== 'paused' || this.operations.has(id)) return false;
        record.phase = 'canceled'; record.error = 'Canceled while paused.'; this.write(record); return true;
    }
    async cancelSaved(event, id) {
        const record = this.records.get(id);
        if (!record?.published || !this.operations.has(id)) return null;
        this.authorize(event); this.sameScope(record); record.skipSetup = true; this.write(record);
        if (record.phase === 'installing') {
            const installations = this.getManager().installations;
            const job = installations.status(record.scope);
            if (!job || job.id !== record.installationId) throw Error('This installation needs to be resolved in Manage Game.');
            if (['checking', 'starting', 'running', 'waiting', 'tracking-lost'].includes(job.phase)) await installations.cancel({ scope: record.scope, jobId: record.installationId, authorize: session => {
                this.authorize(event); this.sameScope(record);
                const reference = this.getStore().authorityStatus(record.scope.gameId).execution;
                return this.getStore().resolveNativeSessionTermination({ gameId: record.scope.gameId, sessionId: session.sessionId,
                    capabilityId: reference.capabilityId, expectedRevision: reference.revision }, session);
            } });
        }
        return { status: 'cancelled_saved', retained: true };
    }
    assertPlayable(gameId) {
        const record = this.forGame(gameId); if (!record) return;
        // Manual Manage Game configuration may finish a download too. An
        // installer can never become a gameplay target through that route.
        const details = this.getStore().localExecutionSetup(gameId).details;
        const name = path.basename(details.executablePath || '');
        if (!name || discovery.INSTALLER.test(name)) throw Error('Finish the downloaded game’s installation in Manage Game before playing.');
        if (record.phase === 'ready') return;
        discovery.validate({ executable: details.executableIdentity, cwd: details.workingDirectoryIdentity,
            backend: require('./proton/wine').windowsBackend(details.linuxRuntime?.backend) ? 'proton-umu' : 'native', root: path.dirname(details.executablePath) }, this.getManager() || {});
        this.getManager()?.installations.assertIdle(record.scope); record.phase = 'ready'; record.error = ''; this.write(record);
    }
    // Hosts whose human check fails under automation: the installed browser downloads the file itself.
    async browserTransfer(item, directory, work, progress) {
        if (typeof this.browserDownload !== 'function') throw Error('This host needs a Chromium-based browser. Download it in your browser, then use "Choose archive".');
        const controller = new AbortController(); await work.setStop(() => controller.abort());
        try {
            const result = await this.browserDownload({ ...item.assisted, directory, fallbackName: item.name, signal: controller.signal, onProgress: progress });
            if (!result || !result.path) throw Error('No Chromium-based browser was found. Download it in your browser, then use "Choose archive".');
            await work.checkpoint();
            return result.path;
        } finally { await work.setStop(null); }
    }
    async run(event, options, imports = null) {
        this.initialize();
        const previous = this.records.get(options.id);
        if (this.operations.has(options.id) || previous && (previous.phase !== 'paused' || imports)) throw Error('Start a new download to retry. Previously saved files were kept.');
        const initialScope = this.scope(), wc = event.sender;
        if (previous && (!isDeepStrictEqual(previous.scope, initialScope) || previous.gameName !== options.gameName)) throw Error('Resume this download from the library it was started in.');
        if (options.rootReference && this.getStore().resolveDeviceRootCapability(options.rootReference).details.rootPath !== options.installDir) throw Error('The selected download root changed.');
        const send = (channel, data) => { if (!wc.isDestroyed()) wc.send(channel, data); };
        const formatBytes = bytes => bytes >= 1024 ** 3 ? (bytes / 1024 ** 3).toFixed(2) + ' GB' : bytes >= 1024 ** 2 ? (bytes / 1024 ** 2).toFixed(1) + ' MB' : bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KB' : Math.round(bytes) + ' B';
        const progress = data => send('download-progress', { id: options.id, ...data,
            ...(data.percent !== undefined ? { percent: Math.floor(data.percent) } : {}),
            ...Object.fromEntries(['downloaded', 'total', 'speed'].filter(key => data[key] !== undefined).map(key => [key, formatBytes(data[key])])) });
        const job = this.registry.begin(options.id, { gameName: options.gameName, installDir: options.installDir, defaultRoot: this.defaultRoot });
        const continuation = await this.registry.beginAttempt(job), controller = { job, continuation, cancelled: false, paused: false };
        let settle; controller.settled = new Promise(resolve => { settle = resolve; });
        let record;
        try {
            const folder = await this.registry.ensureDirectory(continuation);
            if (previous) {
                if (folder !== previous.folder) throw Error('The paused download folder changed. Start the download again.');
                this.validateFolder(previous); record = previous; record.phase = 'downloading'; record.error = '';
            } else {
                record = { protocol: 1, id: options.id, scope: initialScope, gameName: options.gameName, sourceId: options.sourceId,
                    folder, folderIdentity: fileIdentity(folder, 'directory'), finalFolder: job.finalDirectory, published: false, phase: 'downloading', error: '', installationId: '', parts: {} };
            }
            this.write(record); this.operations.set(options.id, record); this.activeDownloads.set(options.id, controller);
            await this.registry.attachControl(continuation, controller, 'downloading');
            const incoming = path.join(folder, 'archives'); if (!previous) fs.mkdirSync(incoming, { mode: 0o700 });
            const files = [];
            if (imports) {
                await this.work.run(continuation, { type: 'archive-import', state: 'downloading' }, async work => {
                    const abort = new AbortController(); await work.setStop(() => abort.abort());
                    try {
                        for (const item of imports) {
                            if (!identityMatches(item.identity, fileIdentity(item.file, 'file')) || fs.realpathSync(item.file) !== item.file) throw Error('The selected archive changed.');
                            const target = path.join(incoming, path.basename(item.file));
                            await pipeline(fs.createReadStream(item.file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW }), fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal: abort.signal });
                            await work.checkpoint();
                            if (!identityMatches(item.identity, fileIdentity(item.file, 'file'))) throw Error('The selected archive changed during import.'); files.push(target);
                        }
                    } finally { await work.setStop(null); }
                });
            } else {
                const links = options.links?.length ? options.links : [{ url: options.url, name: options.gameName }];
                // Per link: how many files it resolved to, which are finished, and the one being written.
                // A resume skips finished files and continues the partial one.
                const parts = record.parts || (record.parts = {});
                const stored = name => { const file = path.join(incoming, name); if (path.basename(name) !== name || !fs.existsSync(file)) throw Error('A finished download part is missing. Start the download again.'); return file; };
                for (let index = 0; index < links.length; index++) {
                    const part = parts[index];
                    if (part && part.done.length === part.count) { files.push(...part.names.map(stored)); continue; }
                    record.pausable = true;
                    progress({ state: 'downloading', label: `Downloading part ${index + 1}/${links.length}…`, part: index + 1, partCount: links.length });
                    const resolved = await this.work.run(continuation, { type: 'linux-link-resolution', state: 'resolving' }, async work => {
                        if (typeof this.resolveDirect !== 'function') return require('./linuxDownloadResolution').resolve(links[index], options, work, { browserResolve: this.browserResolve });
                        // Sail's full resolver handles protected hosts; it can ask the user to pass a check in a browser window.
                        const abort = new AbortController(); await work.setStop(() => abort.abort());
                        try {
                            const files = await this.resolveDirect(links[index].url, { sourceId: options.sourceId, name: links[index].name || options.gameName, referer: options.referer || '',
                                skipDebrid: options.skipDebrid === true, signal: abort.signal, onProgress: label => progress({ state: 'downloading', label: String(label || '').slice(0, 200), part: index + 1, partCount: links.length }) });
                            abort.signal.throwIfAborted(); await work.checkpoint();
                            return require('./linuxDownloadResolution').normalizeManagedFiles(files);
                        } finally { await work.setStop(null); }
                    });
                    const state = parts[index] && parts[index].count === resolved.length ? parts[index] : (parts[index] = { count: resolved.length, done: [], names: [], partial: null });
                    for (let file = 0; file < resolved.length; file++) {
                        if (state.done.includes(file)) { files.push(stored(state.names[file])); continue; }
                        const report = data => progress({ state: 'downloading', label: `Downloading part ${index + 1}/${links.length}…`, part: index + 1, partCount: links.length, file: file + 1, fileCount: resolved.length, ...data });
                        const partial = state.partial && state.partial.file === file ? state.partial.name : '';
                        record.pausable = !resolved[file].assisted;
                        const target = await this.work.run(continuation, { type: 'linux-transfer', state: 'downloading' }, work => resolved[file].assisted
                            ? this.browserTransfer(resolved[file], incoming, work, report)
                            : require('./linuxDownloadTransfer').transfer({ url: resolved[file].url, headers: resolved[file].headers, fallback: resolved[file].name, directory: incoming, maxSpeed: options.maxSpeed, work, progress: report,
                                partial, onTarget: name => { state.partial = { file, name }; this.write(record); } }));
                        record.pausable = true;
                        state.names[file] = path.basename(target); state.done.push(file); state.partial = null; this.write(record);
                        files.push(target);
                    }
                }
            }
            for (let index = 0; index < files.length; index++) {
                const file = files[index], kind = discovery.archiveKind(file);
                if (kind && !/\.(?:(?:zip|rar|7z)(?:\.001)?|r\d{2}|z\d{2}|\d{3})$/i.test(file)) { const target = file + '.' + kind; if (!fs.existsSync(target)) { fs.renameSync(file, target); files[index] = target; } }
            }
            const primaries = files.filter(file => !/\.part(?!0*1\.)\d+\.rar$|\.(?:r\d{2}|z\d{2}|(?!001$)\d{3})$/i.test(file)).filter(file => discovery.archiveKind(file));
            if (options.autoExtract !== false && primaries.length) {
                record.phase = 'extracting'; this.write(record); progress({ state: 'processing', label: 'Extracting game files…' });
                await this.work.run(continuation, { type: 'linux-extraction', state: 'post_processing' }, async work => {
                    let count = 0; const queue = primaries.map(file => ({ file, depth: 0 }));
                    while (queue.length) {
                        const { file, depth } = queue.shift(); if (++count > 16) throw Error('Too many nested game archives. Files were kept.');
                        const destination = path.join(path.dirname(file) === incoming ? folder : path.dirname(file), 'unpacked-' + count);
                        await discovery.extract(file, destination, work);
                        if (depth < 2) for (const nested of discovery.scan([destination], this.getManager() || {}).archives) queue.push({ file: nested, depth: depth + 1 });
                    }
                });
            }
            await this.registry.assertActive(continuation); this.sameScope(record); this.authorize(event);
            record.phase = 'publishing'; this.write(record);
            const publication = await this.registry.publish(continuation); this.registry.forget(job); this.activeDownloads.delete(options.id);
            record.folder = publication.toDirectory; record.folderIdentity = fileIdentity(record.folder, 'directory'); record.published = true; record.phase = 'saved'; this.write(record);
            const metadata = await this.metadata(options.gameName, options.sourceId).catch(() => null);
            this.sameScope(record); this.authorize(event);
            let result = { gameId: 'launcher-device', state: null, snapshot: null, location: this.getStore().createLauncherDirectoryCapability(record.folder) };
            if (options.autoAdd !== false) {
                result = this.getStore().registerDownloadedGameProposal({ gameName: options.gameName, folderPath: record.folder, sourceId: options.sourceId, steamAppId: metadata?.steamAppId });
                record.scope = this.scope(result.gameId); record.phase = 'installation-required'; this.write(record);
                if (options.autoInstall !== false && !record.skipSetup) {
                    try { await this.configure(event, { gameId: result.gameId, includePrerequisites: options.skipRedist === false }); }
                    catch (error) { record.error = safeError(error); this.write(record); }
                }
                result.state = this.getStore().getState(); result.snapshot = this.getStore().loadActiveSnapshot();
            }
            send('download-complete', { id: options.id, gameName: options.gameName, usable: true, ...result,
                localSetupStatus: record.phase === 'ready' ? 'active' : 'local-setup-required',
                warning: record.phase === 'ready' ? '' : record.error || (record.phase === 'installing' ? 'Installation started. Open Manage Game to follow setup.' : 'Files saved. Open Manage Game to finish installation.'),
                linuxDownload: record.scope.gameId === 'launcher-device' ? null : this.status(record.scope.gameId) });
            return { success: true };
        } catch (error) {
            if (record && controller.paused && !controller.cancelled) {
                record.phase = 'paused'; record.pausable = false; record.error = ''; this.write(record);
                try { await this.registry.setState(continuation, 'paused'); } catch (_) { /* Cancel still owns cleanup. */ }
                send('download-progress', { id: options.id, state: 'paused', label: 'Paused' });
                return { success: false, paused: true };
            }
            if (record) { record.phase = controller.cancelled ? 'canceled' : 'failed'; record.pausable = false; record.error = safeError(error); this.write(record); }
            if (!controller.cancelled) {
                try { await this.registry.setState(continuation, 'error'); } catch (_) {}
                // A debrid refusal (an unsupported host, for example) offers "Retry without debrid", as on Windows.
                const debridFailure = error.debridFailure === true && options.skipDebrid !== true;
                send('download-error', { id: options.id, error: safeError(error), needsBrowser: false, debridFailure,
                    debridRejected: error.debridRejected === true, failedDebridService: debridFailure ? String(error.failedDebridService || '').slice(0, 80) : '' });
            }
            return { success: false, cancelled: controller.cancelled, error: safeError(error) };
        } finally { this.activeDownloads.delete(options.id); this.operations.delete(options.id); settle(); }
    }
    async choose(candidates, title, roots) {
        if (candidates.length === 1) return candidates[0];
        if (candidates.length > 1 && candidates.length <= 8) {
            const choice = await this.dialog.showMessageBox({ type: 'question', message: title,
                detail: candidates.map((item, index) => `${index + 1}. ${item.executable.realPath}`).join('\n'),
                buttons: [...candidates.map(item => path.basename(item.executable.realPath)), 'Cancel'], defaultId: candidates.length, cancelId: candidates.length });
            return candidates[choice.response] || null;
        }
        const picked = await this.dialog.showOpenDialog({ title: title + ' (inside the downloaded folder or game environment)', defaultPath: candidates.length ? candidates[0].cwd.realPath : roots.at(-1), properties: ['openFile'] });
        if (picked.canceled || !picked.filePaths?.length) return null;
        const selected = require('./proton/executable').selectLocalExecutable(picked.filePaths[0], { allowScripts: true, ...(this.getManager() || {}) });
        const root = roots.find(value => native.withinRoot(selected.identity.realPath, value)); if (!root) throw Error('Choose an executable inside this download or its Windows environment.');
        return { executable: selected.identity, backend: selected.backend, cwd: native.validateWorkingDirectory(path.dirname(selected.identity.realPath), this.getManager() || {}), root };
    }
    async runtime(runtimeId) {
        const manager = this.getManager(); if (!manager) throw Error('Choose Proton or Wine in Settings → Compatibility.');
        await manager.installedStatus(); const status = manager.status();
        const id = runtimeId || status.defaultRuntimeId;
        if (id) return manager.runtime(id);
        const ready = status.runtimes.filter(item => item.ready); if (!ready.length) throw Error('Choose Proton or Wine in Settings → Compatibility, then finish this download.');
        if (ready.length === 1) return manager.runtime(ready[0].id);
        const decision = await this.dialog.showMessageBox({ type: 'question', message: 'Choose Proton or Wine for this downloaded game', buttons: [...ready.map(item => item.label), 'Cancel'], defaultId: ready.length, cancelId: ready.length });
        return ready[decision.response] ? manager.runtime(ready[decision.response].id) : null;
    }
    async configure(event, { gameId, runtimeId = '', includePrerequisites = true, afterInstallation = false }) {
        const record = this.forGame(gameId); if (!record) throw Error('This game has no retained Sail download.');
        if (this.reviews.has(record.id)) throw Error('This download is already being reviewed.');
        if (this.operations.has(record.id) && record.skipSetup) return { canceled: true };
        if (!this.operations.has(record.id)) record.skipSetup = false;
        this.reviews.add(record.id);
        try {
            this.sameScope(record); this.validateFolder(record);
            const manager = this.getManager(); manager?.installations.assertIdle(record.scope);
            const roots = [record.folder];
            const prefixes = manager ? ['prefixes', 'wine-prefixes'].map(folder => path.join(manager.root, folder, scopeKey(record.scope), 'drive_c')).filter(folder => fs.existsSync(folder)) : [];
            roots.push(...prefixes);
            const found = discovery.scan(roots, { ...(manager || {}), prefixRoots: prefixes });
            if (afterInstallation && !found.games.length) throw Error('Installation finished, but no playable executable was detected. Use Finish downloaded game setup to select it. Archives and installed files were kept.');
            const candidates = found.games.length ? found.games : found.installers;
            const candidate = await this.choose(candidates, found.games.length ? 'Choose the game executable' : 'Choose the Windows setup executable', roots);
            if (!candidate) return { canceled: true };
            const isInstaller = discovery.INSTALLER.test(path.basename(candidate.executable.realPath));
            if (isInstaller && candidate.backend !== 'proton-umu') throw Error('Choose a Windows setup executable.');
            const runtime = candidate.backend === 'proton-umu' ? await this.runtime(runtimeId || this.getStore().localExecutionSetup(gameId).details.linuxRuntime?.runtimeId) : null;
            if (candidate.backend === 'proton-umu' && !runtime) return { canceled: true };
            const steps = isInstaller ? [installer(candidate.executable.realPath, { expected: candidate.executable, fixtureRoot: manager.fixtureRoot })] : [];
            if (runtime && includePrerequisites) {
                // Games often put their executable in Binaries/Win64 and their
                // redists alongside the game root. Check those ancestors too.
                let folder = candidate.cwd.realPath;
                while (native.withinRoot(folder, candidate.root)) {
                    for (const item of discover({ executablePath: candidate.executable.realPath, workingDirectory: folder, fixtureRoot: manager.fixtureRoot }).candidates) {
                        if (!steps.some(step => step.executable.realPath === item.executable.realPath)) steps.push(item);
                    }
                    if (folder === candidate.root) break;
                    folder = path.dirname(folder);
                }
            }
            if (steps.length > 16) throw Error('Too many bundled prerequisites. Install a smaller set from Manage Game.');
            if (runtime && steps.length) manager.assertLaunchReady(require('./proton/wine').runtimeBackend(runtime));
            const decision = await this.dialog.showMessageBox({ type: 'question', message: isInstaller ? 'Install this downloaded game?' : 'Save this downloaded game’s launch setup?',
                buttons: [isInstaller ? 'Run installation' : steps.length ? 'Save setup and install prerequisites' : 'Save launch setup', 'Cancel'], defaultId: 1, cancelId: 1,
                detail: `Executable: ${candidate.executable.realPath}\nWorking folder: ${candidate.cwd.realPath}${runtime ? '\nCompatibility: ' + runtime.label : ''}${steps.length ? '\n\nInstallers:\n' + steps.map(step => step.label + '\n' + step.executable.realPath).join('\n\n') : ''}\n\n${isInstaller ? 'Use the installer’s normal interface. Keep its default C: destination inside this game’s Windows environment. Setup and bundled prerequisites do not count as gameplay. ' : ''}These programs can access files as your user. Approve files you trust. Existing archives and saves are kept.` });
            if (decision.response !== 0) return { canceled: true };
            if (record.skipSetup) return { canceled: true };
            this.authorize(event); this.sameScope(record); this.validateFolder(record); discovery.validate(candidate, manager || {});
            manager?.installations.assertIdle(record.scope); if (runtime) manager.runtime(runtime.id);
            const saved = this.getStore().localExecutionSetup(gameId).details;
            const capability = this.getStore().createExecutionCapability(gameId, { executablePath: candidate.executable.realPath,
                workingDirectory: candidate.cwd.realPath, argv: isInstaller ? [] : saved.argv || [], ...(runtime ? { linuxRuntime: { backend: require('./proton/wine').runtimeBackend(runtime), runtimeId: runtime.id, dllOverrides: isInstaller ? '' : saved.linuxRuntime?.dllOverrides || '' } } : {}) });
            if (steps.length) {
                // The selected setup PE anchors installation authority; Play is
                // gated until an installed game replaces this local permission.
                record.phase = 'installation-required'; this.write(record);
                const execution = this.resolveExecution({ gameId, capabilityId: capability.capabilityId, expectedRevision: capability.revision });
                const job = manager.installations.start({ ...execution, steps }); record.installationId = job.id; record.phase = 'installing';
                record.installationType = isInstaller ? 'game' : 'prerequisites'; record.approvedGame = isInstaller ? null : candidate.executable;
            } else { record.phase = 'ready'; record.installationId = ''; }
            record.error = ''; this.write(record);
            const result = { canceled: false, ...this.status(gameId), state: this.getStore().getState(), snapshot: this.getStore().loadActiveSnapshot() };
            this.emit('linux-download-state', result); return result;
        } finally { this.reviews.delete(record.id); }
    }
}
module.exports = { LinuxDownloads };
