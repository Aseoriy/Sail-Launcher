'use strict';

function bindAchievementArtwork({ image, item, game, ipc, currentLibraryKey, SafeDom }) {
    if (!image || !item || !SafeDom || !ipc || typeof ipc.invoke !== 'function') return false;
    const remote = item.unlocked ? (item.icon || item.iconGray) : (item.iconGray || item.icon);
    const source = SafeDom.safeImageUrl(remote, {
        allowSteam: true,
        allowData: true,
        maxDataLength: 2 * 1024 * 1024
    });
    const canRequestLocal = game && game.id && item.id && typeof currentLibraryKey === 'function';
    if (!source && !canRequestLocal) return false;
    if (source) {
        SafeDom.setImageSource(image, source, {
            allowSteam: true,
            allowData: true,
            maxDataLength: 2 * 1024 * 1024
        });
    } else {
        image.hidden = true;
    }
    image.addEventListener('error', () => { image.hidden = true; }, { once: true });
    if (canRequestLocal) {
        const libraryKey = currentLibraryKey();
        Promise.resolve(ipc.invoke('achievements-read-artwork', {
            gameId: String(game.id),
            itemId: String(item.id).slice(0, 512),
            variant: item.unlocked ? 'unlocked' : 'locked',
            libraryKey
        })).then(result => {
            if (!image.isConnected || libraryKey !== currentLibraryKey()
                || !result || !result.available) return;
            const localSource = SafeDom.safeImageUrl(result.dataUrl, {
                allowSteam: false,
                allowData: true,
                maxDataLength: 2 * 1024 * 1024
            });
            if (!localSource) return;
            SafeDom.setImageSource(image, localSource, {
                allowSteam: false,
                allowData: true,
                maxDataLength: 2 * 1024 * 1024
            });
            image.hidden = false;
        }).catch(() => {});
    }
    return true;
}

module.exports = { bindAchievementArtwork };
