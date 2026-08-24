'use strict';

const PHASES = new Set(['pre-script', 'companion', 'launch', 'post-script']);

function createExecutionPhaseAuthority({ profileStore, gameId, resolvedCapability }) {
    if (!profileStore || typeof profileStore.validateExecutionCapability !== 'function') {
        throw new TypeError('Execution phases require the main-owned profile store.');
    }
    const replacement = resolvedCapability && resolvedCapability.replacement;
    if (!replacement || typeof replacement.capabilityId !== 'string'
        || !Number.isSafeInteger(replacement.revision)) {
        throw new Error('The launch capability could not be renewed.');
    }
    const expectedGameId = String(gameId || '');
    return Object.freeze({
        resolve(phase) {
            if (!PHASES.has(phase)) throw new TypeError('Unknown execution phase.');
            return profileStore.validateExecutionCapability({
                capabilityId: replacement.capabilityId,
                expectedRevision: replacement.revision,
                gameId: expectedGameId,
                operation: 'launch'
            }).details;
        }
    });
}

module.exports = { createExecutionPhaseAuthority };
