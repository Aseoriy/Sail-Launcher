'use strict';

// Local artwork is requested from the main process only for rows close to the screen, so a long
// achievement list does not send one request per row when it opens. One observer is shared.
const nearScreen = new WeakMap();
let nearScreenObserver = null;

function whenNearScreen(element, callback) {
    if (!element || typeof IntersectionObserver !== 'function') { callback(); return; }
    if (!nearScreenObserver) {
        nearScreenObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const pending = nearScreen.get(entry.target);
                nearScreenObserver.unobserve(entry.target);
                nearScreen.delete(entry.target);
                if (pending) pending();
            }
        }, { rootMargin: '600px 0px' });
    }
    nearScreen.set(element, callback);
    nearScreenObserver.observe(element);
}

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
        const request = () => Promise.resolve(ipc.invoke('achievements-read-artwork', {
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
        // The caller wraps the image after this returns, so look for its row on the next tick.
        Promise.resolve().then(() => {
            if (!image.isConnected) { request(); return; }
            whenNearScreen(image.closest('.achievement-row') || image.parentElement || image, request);
        });
    }
    return true;
}

module.exports = { bindAchievementArtwork };
