'use strict';

// Serialize library updates, including retries whose ID is already in memory.
// Scheduling a capture is not a durable acknowledgement.
function createRuntimeCompletionQueue({ getLibraryKey, getGames, fetchPending, save, flush, acknowledge }) {
    let queue = Promise.resolve();
    return event => {
        const run = queue.then(async () => {
            if (!event || !event.id || event.libraryKey && event.libraryKey !== getLibraryKey()) return -1;
            const pending = await fetchPending(event.id);
            if (!pending) return -1;
            if (pending.libraryKey !== getLibraryKey()) return -1;
            const games = getGames();
            const index = games.findIndex(game => String(game.id) === String(pending.gameId));
            if (index < 0) return -1;
            const game = games[index];
            const applied = Array.isArray(game.playtimeSessionIds) ? game.playtimeSessionIds : [];
            if (!applied.includes(pending.id)) {
                if (pending.creditPlaytime !== false) game.playtime = (Number(game.playtime) || 0) + Math.max(0, Number(pending.durationSeconds) || 0);
                if (pending.creditPlaytime !== false && pending.outcome !== 'launch-failed') game.lastPlayed = Math.max(Number(game.lastPlayed) || 0, Number(pending.startedAt) || 0) || game.lastPlayed;
                game.playtimeSessionIds = [...applied, pending.id].slice(-50);
                if (!save()) throw new Error('Playtime remains pending because local state could not be saved.');
            }
            await flush();
            if (getLibraryKey() !== pending.libraryKey || getGames() !== games) throw new Error('The active library changed while saving playtime; its completion remains pending.');
            await acknowledge(pending.id);
            return index;
        });
        queue = run.catch(() => {});
        return run;
    };
}
module.exports = { createRuntimeCompletionQueue };
