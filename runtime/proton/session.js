'use strict';

const { UUID } = require('../native/protocol');

function validateLaunchMetadata(metadata) {
    if (metadata === undefined) return undefined;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || Object.keys(metadata).some(key => !['backend', 'runtimeId', 'prefixKey', 'label', 'activity', 'installationId', 'installationStep'].includes(key))
        || !require('./wine').windowsBackend(metadata.backend) || !UUID.test(metadata.runtimeId)
        || !/^[0-9a-f]{64}$/.test(metadata.prefixKey) || typeof metadata.label !== 'string' || metadata.label.length > 160
        || (metadata.activity !== undefined && !['preparation', 'game', 'installation'].includes(metadata.activity))
        || metadata.backend === 'wine' && metadata.activity === 'preparation'
        || (metadata.activity === 'installation' ? !UUID.test(metadata.installationId) || !Number.isSafeInteger(metadata.installationStep)
            || metadata.installationStep < 0 || metadata.installationStep > 15 : metadata.installationId !== undefined || metadata.installationStep !== undefined)) {
        throw new Error('Invalid Proton session binding.');
    }
    return { backend: metadata.backend, runtimeId: metadata.runtimeId, prefixKey: metadata.prefixKey,
        label: metadata.label, activity: metadata.activity || 'game',
        ...(metadata.activity === 'installation' ? { installationId: metadata.installationId, installationStep: metadata.installationStep } : {}) };
}

function protonActivity(session) {
    const metadata = session?.native?.launchMetadata;
    if (!require('./wine').windowsBackend(metadata?.backend)) return null;
    return validateLaunchMetadata(metadata).activity;
}

function completionPolicy(session, receipt) {
    const activity = protonActivity(session);
    if (!activity) return { creditPlaytime: true, outcome: receipt.phase };
    if (activity === 'game' && require('./tracking').confirmedGame(session, receipt)) return { creditPlaytime: true, activity, outcome: 'windows-game-ended' };
    if (activity === 'game' && receipt.game?.error) return { creditPlaytime: false, activity, outcome: 'windows-tracking-failed' };
    // A native receipt confirms the UMU wrapper, not a Windows game. Even a
    // successful, quiescent createprefix command needs separate initialization
    // acceptance. Neither wrapper duration nor file presence is game evidence.
    const failed = !receipt.execSucceeded || receipt.rootCode !== 0 || receipt.rootSignal !== 0;
    if (activity === 'installation') return { creditPlaytime: false, activity,
        outcome: receipt.phase === 'stopped' ? 'installation-stopped' : failed ? 'installation-failed' : 'installation-finished' };
    return { creditPlaytime: false, activity,
        outcome: activity === 'preparation' ? (failed ? 'preparation-failed' : 'preparation-unverified')
            // A Windows program can run and later exit with any code/signal.
            // Only a kernel exec failure proves that UMU could not start here.
            : (!receipt.execSucceeded ? 'windows-launch-failed' : 'windows-start-unverified') };
}

module.exports = { validateLaunchMetadata, protonActivity, completionPolicy };
