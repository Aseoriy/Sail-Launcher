'use strict';
const { isDeepStrictEqual } = require('node:util');
const { discover, installer, validateStep } = require('./prerequisites');
const native = require('../native/protocol');
const { validateWindowsExecutable } = require('./executable');
const packages = require('./prerequisitePackages');
const { recommendations } = require('./recommendations');

function registerWindowsInstallationIpc({ ipcMain, dialog, authorize, getStore, getInstallations, resolveExecution, isUninstalling, exactPayload, getGameRoots = () => [], isExiting = () => false }) {
    const handle = (channel, handler) => ipcMain.handle(channel, async (event, payload) => {
        try { return { success: true, data: await handler(event, payload) }; }
        catch (error) { return { success: false, error: String(error.message || error).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) }; }
    });
    const scope = gameId => { const value = getStore().authorityScope(gameId); return { profileId: value.profileId, libraryId: value.libraryId, gameId: String(gameId) }; };
    function context(gameId) {
        const binding = scope(gameId), store = getStore(), details = store.localExecutionSetup(gameId).details;
        const installations = getInstallations();
        if (!installations) throw Error('Windows installation is unavailable.');
        if (!require('./wine').windowsBackend(details.linuxRuntime?.backend) || store.authorityStatus(gameId).execution.state !== 'active') throw Error('Save this game’s Proton or Wine launch setup before installing.');
        native.assertNativeOptions(details);
        validateWindowsExecutable(details.executablePath, { expected: details.executableIdentity, fixtureRoot: installations.manager.fixtureRoot });
        native.validateWorkingDirectory(details.workingDirectory, { expected: details.workingDirectoryIdentity, fixtureRoot: installations.manager.fixtureRoot });
        installations.manager.runtime(details.linuxRuntime.runtimeId);
        return { scope: binding, details, installations };
    }
    const firstPlan = (gameId, current) => current.installations.manager.firstLaunch?.plan({ scope: current.scope, details: current.details, roots: getGameRoots(gameId) }) || { available: false, reviewRequired: false };
    handle('proton-first-launch-plan', (event, payload) => {
        const input = exactPayload(payload, ['gameId'], 'First-launch setup'); authorize(event);
        return firstPlan(input.gameId, context(input.gameId));
    });
    handle('proton-first-launch-begin', async (event, payload) => {
        const input = exactPayload(payload, ['gameId', 'fingerprint', 'capabilityId', 'expectedRevision'], 'First-launch setup'); authorize(event);
        const before = context(input.gameId), service = before.installations.manager.firstLaunch;
        if (!service?.enabled || isUninstalling(input.gameId) || isExiting()) throw Error('First-launch setup is unavailable while Sail or the game is closing.');
        before.installations.assertIdle(before.scope);
        const permission = () => getStore().resolveExecutionCapability({ gameId: input.gameId, capabilityId: input.capabilityId,
            expectedRevision: input.expectedRevision, operation: 'launch' }, { consume: false });
        permission();
        const plan = firstPlan(input.gameId, before);
        if (plan.fingerprint !== input.fingerprint || plan.busy) throw Error('The game setup changed. Click Play again to review it.');
        if (!plan.reviewRequired) return { ready: true, fingerprint: plan.fingerprint };
        const selected = plan.recipeIds.map(require('./prerequisitePackages').recipe);
        const canInstall = selected.length && !plan.unknownIds.length;
        const buttons = canInstall ? ['Set up & Play', 'Play without these components', 'Manage components', 'Cancel'] : ['Play anyway', 'Manage components', 'Cancel'];
        const selectedDetails = selected.map(item => `${item.label} ${item.version} (${(item.size / 1024 ** 2).toFixed(1)} MB)\n${item.infoUrl}\n${plan.components.find(c => c.id === item.id).reasons.join(' ')}`).join('\n\n');
        const guidance = (plan.guidance || []).map(item => `${item.title}: ${item.detail}`).join('\n\n');
        const decision = await dialog.showMessageBox({ type: 'question', message: 'Set up this Windows game before playing?', buttons,
            defaultId: buttons.length - 1, cancelId: buttons.length - 1,
            detail: `Compatibility: ${plan.runtimeLabel}\n\n${selectedDetails ? selectedDetails + '\n\n' : ''}${plan.reason}\n\n${plan.warnings.join('\n')}${guidance ? '\n\n' + guidance : ''}\n\nSail recommends common components from local game files. This is not a complete list of the game's requirements. Set up & Play downloads pinned packages from Microsoft into this game's separate Windows environment, then starts the game while Sail remains open. Microsoft’s component license terms apply. Setup adds no playtime. Existing files and saves are kept. Manage Game lets you choose other components. Playing without setup is remembered for this executable and compatibility version.` });
        if (decision.response === buttons.length - 1 || decision.response < 0 || decision.response >= buttons.length) return { canceled: true };
        if (decision.response === (canInstall ? 2 : 1)) return { manage: true };
        authorize(event); const current = context(input.gameId), fresh = firstPlan(input.gameId, current);
        if (isExiting() || isUninstalling(input.gameId) || !isDeepStrictEqual(current.scope, before.scope) || !isDeepStrictEqual(current.details, before.details)
            || fresh.fingerprint !== plan.fingerprint || fresh.busy || JSON.stringify(fresh.recipeIds) !== JSON.stringify(plan.recipeIds)
            || JSON.stringify(fresh.unknownIds) !== JSON.stringify(plan.unknownIds)) throw Error('The game setup changed during review. Click Play again.');
        current.installations.assertIdle(current.scope);
        permission();
        if (!canInstall || decision.response === 1) {
            service.remember(current.scope, fresh.fingerprint, 'skip'); return { ready: true, fingerprint: fresh.fingerprint };
        }
        const execution = resolveExecution(input);
        if (!isDeepStrictEqual(execution.scope, current.scope)) throw Error('The active game scope changed.');
        const downloads = current.installations.manager.prerequisites;
        const job = downloads.start({ ...execution, recipeIds: fresh.recipeIds });
        try { service.remember(current.scope, fresh.fingerprint, 'setup', fresh.recipeIds, job.id); }
        catch (error) {
            // start yields at its first requirements check. Do not let a failed
            // durable review record leave an unreported acquisition executing.
            downloads.cancel(current.scope, job.id); throw error;
        }
        return { ready: false, fingerprint: fresh.fingerprint, job, capability: execution.capability };
    });
    handle('proton-installation-status', (_event, payload) => {
        const input = exactPayload(payload, ['gameId'], 'Windows installation status');
        const installations = getInstallations(); if (!installations) throw Error('Windows installation is unavailable.');
        const binding = scope(input.gameId), saved = getStore().localExecutionSetup(input.gameId);
        const wineReady = saved.details.linuxRuntime?.backend !== 'wine' || installations.manager.wineLaunchReadiness().available;
        return { available: wineReady && require('./wine').windowsBackend(saved.details.linuxRuntime?.backend) && getStore().authorityStatus(input.gameId).execution.state === 'active',
            reason: wineReady ? '' : require('./wine').WINE_PENDING_REASON,
            job: installations.status(binding), ...(installations.manager.prerequisites ? { online: installations.manager.prerequisites.status(binding) } : {}) };
    });
    handle('proton-check-online-prerequisites', (_event, payload) => {
        const input = exactPayload(payload, ['gameId'], 'Check Windows components'), current = context(input.gameId);
        const downloads = current.installations.manager.prerequisites;
        if (!downloads) throw Error('Prerequisite downloads are unavailable.');
        current.installations.assertIdle(current.scope);
        const result = downloads.check(current.scope, current.details.linuxRuntime.runtimeId), hints = recommendations(current.details, current.installations.manager, getGameRoots(input.gameId));
        return { ...result, components: result.components.map(item => ({ ...item, recommended: !!hints.reasons[item.id], reasons: hints.reasons[item.id] || [] })),
            warnings: hints.warnings, guidance: hints.guidance };
    });
    handle('proton-install-online-prerequisites', async (event, payload) => {
        const input = exactPayload(payload, ['gameId', 'capabilityId', 'expectedRevision', 'recipeIds'], 'Download Windows components');
        if (!Array.isArray(input.recipeIds) || !input.recipeIds.length || input.recipeIds.length > packages.MAX_RECIPES
            || new Set(input.recipeIds).size !== input.recipeIds.length) throw Error('Choose a bounded set of supported components.');
        const selected = input.recipeIds.map(packages.recipe);
        if (isUninstalling(input.gameId)) throw Error('This game is currently being uninstalled.');
        const before = context(input.gameId), downloads = before.installations.manager.prerequisites;
        if (!downloads) throw Error('Prerequisite downloads are unavailable.');
        downloads.assertCanStart(before.scope);
        const decision = await dialog.showMessageBox({ type: 'question', buttons: ['Download and install', 'Cancel'], defaultId: 1, cancelId: 1,
            message: 'Install these Microsoft components for this game?',
            detail: `${selected.map(item => `${item.label} ${item.version} (${(item.size / 1024 ** 2).toFixed(1)} MB)\n${item.infoUrl}`).join('\n\n')}\n\nDownloads verified packages from Microsoft. Uses this game’s separate Windows environment and saved compatibility version. Microsoft’s component license terms apply. Already detected components are skipped. Installation time does not add playtime. Legacy DirectX installs optional components alongside the compatibility runner’s graphics support.` });
        if (decision.response !== 0) return { canceled: true };
        authorize(event);
        const current = context(input.gameId);
        if (!isDeepStrictEqual(current.scope, before.scope) || !isDeepStrictEqual(current.details, before.details)
            || isUninstalling(input.gameId)) throw Error('The game setup changed during review. Reopen Manage Game.');
        downloads.assertCanStart(current.scope);
        const execution = resolveExecution(input);
        if (!isDeepStrictEqual(execution.scope, current.scope)) throw Error('The active game scope changed.');
        return { canceled: false, job: downloads.start({ ...execution, recipeIds: input.recipeIds }), capability: execution.capability };
    });
    handle('proton-cancel-online-prerequisites', (event, payload) => {
        const input = exactPayload(payload, ['gameId', 'jobId'], 'Cancel prerequisite download');
        if (!native.UUID.test(input.jobId)) throw Error('Invalid prerequisite download.');
        authorize(event);
        const downloads = getInstallations()?.manager.prerequisites;
        if (!downloads) throw Error('Prerequisite downloads are unavailable.');
        return downloads.cancel(scope(input.gameId), input.jobId);
    });
    handle('proton-prerequisites', (_event, payload) => {
        const input = exactPayload(payload, ['gameId'], 'Bundled prerequisites'), current = context(input.gameId);
        const result = discover({ ...current.details, fixtureRoot: current.installations.manager.fixtureRoot });
        return { candidates: result.candidates.map(item => ({ id: item.id, label: item.label })), issues: result.issues, truncated: result.truncated };
    });
    handle('proton-run-installer', async (event, payload) => {
        const input = exactPayload(payload, ['gameId', 'capabilityId', 'expectedRevision', 'mode', 'includePrerequisites'], 'Windows installation');
        if (!['installer', 'prerequisites'].includes(input.mode) || typeof input.includePrerequisites !== 'boolean') throw Error('Choose a Windows installer or bundled prerequisites.');
        if (isUninstalling(input.gameId)) throw Error('This game is currently being uninstalled.');
        const before = context(input.gameId); before.installations.assertIdle(before.scope);
        const options = { fixtureRoot: before.installations.manager.fixtureRoot }, steps = [];
        if (input.mode === 'installer') {
            const picked = await dialog.showOpenDialog({ title: 'Choose a Windows installer for this game', properties: ['openFile'],
                filters: [{ name: 'Windows executable', extensions: ['exe'] }] });
            if (picked.canceled || !picked.filePaths?.length) return { canceled: true };
            steps.push(installer(picked.filePaths[0], options));
        }
        if (input.mode === 'prerequisites' || input.includePrerequisites) {
            const sources = [before.details, ...(steps.length ? [{ executablePath: steps[0].executable.realPath, workingDirectory: steps[0].cwd.realPath }] : [])];
            for (const source of sources) {
                for (const candidate of discover({ ...source, ...options }).candidates) {
                    if (!steps.some(step => step.executable.dev === candidate.executable.dev && step.executable.ino === candidate.executable.ino)) steps.push(candidate);
                }
            }
        }
        if (!steps.length) throw Error('No supported bundled prerequisites found. Choose a local installer to install other components.');
        if (steps.length > 16) throw Error('Too many prerequisite installers. Run a smaller set separately.');
        const decision = await dialog.showMessageBox({ type: 'question', buttons: ['Run installation', 'Cancel'], defaultId: 1, cancelId: 1,
            message: 'Run these Windows installers for this game?',
            detail: `Compatibility: ${before.installations.manager.runtime(before.details.linuxRuntime.runtimeId).label}\n\n${steps.map(step => `${step.label}\n${step.executable.realPath}`).join('\n\n')}\n\nThese local programs run in this game’s separate Windows environment and can access files as your user. Their filenames do not verify their publisher. Only run installers you trust. No Linux administrator access is requested. Installation time does not add playtime. First use may download a missing Linux runtime. After setup, choose the installed game executable in Manage Game if needed.` });
        if (decision.response !== 0) return { canceled: true };
        authorize(event);
        const current = context(input.gameId);
        if (!isDeepStrictEqual(current.scope, before.scope) || !isDeepStrictEqual(current.details, before.details)) throw Error('The game setup changed during selection. Reopen Manage Game.');
        current.installations.assertIdle(current.scope);
        for (const step of steps) validateStep(step, options);
        const execution = resolveExecution(input);
        if (!isDeepStrictEqual(execution.scope, current.scope)) throw Error('The active game scope changed.');
        const job = current.installations.start({ ...execution, steps });
        return { canceled: false, job, capability: execution.capability };
    });
    handle('proton-installation-cancel', async (event, payload) => {
        const input = exactPayload(payload, ['gameId', 'jobId', 'capabilityId', 'expectedRevision'], 'Cancel Windows installation');
        if (!native.UUID.test(input.jobId)) throw Error('Invalid Windows installation.');
        const installations = getInstallations(); if (!installations) throw Error('Windows installation is unavailable.');
        return installations.cancel({ scope: scope(input.gameId), jobId: input.jobId, authorize: session => {
            authorize(event); return getStore().resolveNativeSessionTermination({ gameId: input.gameId, sessionId: session.sessionId,
                capabilityId: input.capabilityId, expectedRevision: input.expectedRevision }, session);
        } });
    });
}
module.exports = { registerWindowsInstallationIpc };
