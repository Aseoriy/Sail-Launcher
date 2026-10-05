'use strict';

// Main-owned journal state protects the profile/library that supplies session
// controls and durable completion credit. Renderer snapshots cannot release it.
function createNativeMutationGuard(snapshot) {
    return change => {
        const state = snapshot();
        const work = [...Object.values(state.activeSessions || {}), ...(state.completedSessions || [])]
            .filter(item => item.provider === 'linux-native');
        const scope = change.scope || {};
        const key = `${scope.profileId}:${scope.libraryId}`;
        const blocked = work.some(item => {
            if (change.type === 'profile') return item.libraryKey.startsWith(`${scope.profileId}:`);
            if (item.libraryKey !== key) return false;
            if (change.type === 'remove-game') return item.gameId === scope.gameId;
            if (change.type === 'capture') return change.currentGameIds.includes(item.gameId) && !change.gameIds.includes(item.gameId);
            return true;
        });
        if (blocked) {
            const error = new Error('Stop or resolve the affected native game and finish saving its playtime before removing it or changing its profile or library. Other local edits remain available.');
            error.code = 'SAIL_NATIVE_PROFILE_BUSY';
            throw error;
        }
    };
}
module.exports = { createNativeMutationGuard };
