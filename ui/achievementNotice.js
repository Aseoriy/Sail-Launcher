'use strict';

// A Steam game can have its achievement list without Sail knowing what's unlocked (that needs
// a Steam ID + API key, or files on this PC). With neither, "0 of N" is missing info, not a
// result, so the page says that.
function unlockDataMissing({ game, summary, tracking = true, credentialsReady = false }) {
    const appId = String((game && game.steamAppId) || (game && game.achievementData && game.achievementData.appId) || '').trim();
    return !!appId && tracking !== false && !credentialsReady && !!summary && summary.total > 0 && summary.unlocked === 0;
}

const SHORT_NOTE = 'No unlock data on this PC yet';
const LONG_NOTE = 'Sail has this game’s achievement list but no record of what you have unlocked. Unlocks are read from your Steam account (add your Steam ID and Web API key in Settings > Social) or from this PC’s own files, such as Steam’s or an emulator’s, once you earn one.';

module.exports = { unlockDataMissing, SHORT_NOTE, LONG_NOTE };
