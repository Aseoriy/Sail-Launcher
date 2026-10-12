'use strict';

// A Steam game can have its achievement list (from Steam's public data) without anyone having told Sail which of
// them are unlocked. Unlocks come from the player's own Steam account (needs a Steam ID and Web API key) or from
// files on this PC (Steam's own, or an emulator's). When neither has produced an unlock, "0 of N" is not a result
// but a gap, and the page says so instead of looking like a fault.
function unlockDataMissing({ game, summary, tracking = true, credentialsReady = false }) {
    const appId = String((game && game.steamAppId) || (game && game.achievementData && game.achievementData.appId) || '').trim();
    return !!appId && tracking !== false && !credentialsReady && !!summary && summary.total > 0 && summary.unlocked === 0;
}

const SHORT_NOTE = 'No unlock data on this PC yet';
const LONG_NOTE = 'Sail has this game’s achievement list but no record of what you have unlocked. Unlocks are read from your Steam account (add your Steam ID and Web API key in Settings > Social) or from this PC’s own files, such as Steam’s or an emulator’s, once you earn one.';

module.exports = { unlockDataMissing, SHORT_NOTE, LONG_NOTE };
