'use strict';

// A custom banner is a file on one device (customBannerPath) plus a small copy kept with the game
// (customBanner, a JPEG data URL) so the banner still shows when that file is gone or on another device.
// It stays under the device store's 32 KB string limit (about 24 KB of JPEG), which also keeps a cloud
// library with many custom banners well inside its 16 MB limit.
const MAX_BANNER_DATA_URL = 32000;
const BANNER_DATA_URL = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const ATTEMPTS = [[920, 75], [760, 68], [640, 62], [520, 58], [400, 55]];

function portableBanner(nativeImage, filePath) {
    return portableBannerFromImage(nativeImage.createFromPath(String(filePath || '')));
}

// Electron's createFromPath cannot read WebP, so the renderer decodes those itself and passes the image here.
function portableBannerFromImage(image) {
    if (!image || image.isEmpty()) return '';
    const { width } = image.getSize();
    for (const [maxWidth, quality] of ATTEMPTS) {
        const scaled = width > maxWidth ? image.resize({ width: maxWidth, quality: 'good' }) : image;
        const url = `data:image/jpeg;base64,${scaled.toJPEG(quality).toString('base64')}`;
        if (url.length <= MAX_BANNER_DATA_URL) return url;
    }
    return '';
}

function isPortableBanner(value) {
    return typeof value === 'string' && value.length <= MAX_BANNER_DATA_URL && BANNER_DATA_URL.test(value);
}

// The image to show for a custom banner, or '' so callers fall back to Steam art or the icon.
function customBannerUrl(game, { fileExists, safeImageUrl }) {
    if (!game) return '';
    if (game.customBannerPath && fileExists(String(game.customBannerPath))) {
        const url = safeImageUrl(String(game.customBannerPath), { allowFile: true });
        if (url) return url;
    }
    return isPortableBanner(game.customBanner) ? safeImageUrl(game.customBanner, { allowData: true, maxDataLength: MAX_BANNER_DATA_URL }) : '';
}

module.exports = { MAX_BANNER_DATA_URL, portableBanner, portableBannerFromImage, isPortableBanner, customBannerUrl };
