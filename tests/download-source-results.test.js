'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    applySteamMetadataToDownloadedGame,
    cleanDownloadedGameName,
    fullScreenshotImageUrl,
    normalizeFitGirlPostCovers,
    normalizeFitGirlPosts,
    normalizeRemoteImageUrl,
    normalizeSteamRipDownloadUrl,
    normalizeSteamRipGofileContainerUrl,
    normalizeSteamRipResultUrl,
    normalizeDownloadSetHost,
    groupDownloadSets,
    parseSteamRipDownloadLinks,
    parseSteamRipResults,
    paginationWindow,
    isSteamCatalogDownloadSource,
    repairDownloadedSteamGameMetadata,
    steamStoreMetadataForDownloadedGame,
    steamRipDownloadHostLabel
} = require('../ui/downloadSourceLogic');

test('Steam download metadata cleans repack versions and prefers the exact store result', () => {
    assert.equal(cleanDownloadedGameName('Supermarket Chaos – v1.0.5.2 + Bonus'), 'Supermarket Chaos');
    assert.equal(isSteamCatalogDownloadSource('steamrip'), true);
    assert.equal(isSteamCatalogDownloadSource('browser'), false);
    assert.deepEqual(steamStoreMetadataForDownloadedGame('Supermarket Chaos', {
        items: [
            { id: 111, name: 'Supermarket Simulator' },
            { id: 4800590, name: 'Supermarket Chaos™' }
        ]
    }), {
        steamAppId: '4800590',
        steamImageUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/4800590/header.jpg',
        steamHeroUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/4800590/library_hero.jpg'
    });
});

test('download completion promotes valid Steam metadata without replacing local launch authority', () => {
    const game = {
        id: 'downloaded-game',
        platform: 'custom',
        sourceIdentifier: 'steamrip',
        localSetupStatus: 'active'
    };

    assert.equal(applySteamMetadataToDownloadedGame(game, { steamAppId: '3379220' }), true);
    assert.equal(game.platform, 'steam');
    assert.equal(game.steamAppId, '3379220');
    assert.equal(game.sourceIdentifier, '3379220');
    assert.equal(game.localSetupStatus, 'active');
    assert.match(game.steamImageUrl, /\/3379220\/header\.jpg$/);
    assert.match(game.steamHeroUrl, /\/3379220\/library_hero\.jpg$/);

    const unchanged = { platform: 'custom', sourceIdentifier: 'steamrip' };
    assert.equal(applySteamMetadataToDownloadedGame(unchanged, { steamAppId: 'not-an-app-id' }), false);
    assert.deepEqual(unchanged, { platform: 'custom', sourceIdentifier: 'steamrip' });
});

test('existing downloaded custom rows self-repair without changing user-created custom games', () => {
    const affected = { source: 'sail-download', platform: 'custom', steamAppId: '4800590' };
    assert.equal(repairDownloadedSteamGameMetadata(affected), true);
    assert.equal(affected.platform, 'steam');
    assert.equal(affected.sourceIdentifier, '4800590');

    const userCreated = { source: 'local-import', platform: 'custom', steamAppId: '4800590' };
    assert.equal(repairDownloadedSteamGameMetadata(userCreated), false);
    assert.equal(userCreated.platform, 'custom');
});

test('download result pagination keeps the current page visible without rendering every page', () => {
    assert.deepEqual(paginationWindow(1, 17), [1, 2, 3, 4, 5, null, 17]);
    assert.deepEqual(paginationWindow(9, 17), [1, null, 8, 9, 10, null, 17]);
    assert.deepEqual(paginationWindow(17, 17), [1, null, 13, 14, 15, 16, 17]);
    assert.deepEqual(paginationWindow(3, 4), [1, 2, 3, 4]);
});

test('FitGirl multipart mirrors group by provider while language packs and other mirrors stay separate', () => {
    const links = [
        { label: 'FuckingFast Part 2', type: 'web', url: 'https://fuckingfast.co/files/game.part2.rar' },
        { label: 'FuckingFast Part 1', type: 'web', url: 'https://www.fuckingfast.com/files/game.part1.rar' },
        { label: 'FuckingFast Part 3', type: 'web', url: 'https://fuckingfast.net/files/game.part3.rar' },
        { label: 'FileDitch Part 1', type: 'web', url: 'https://fileditchfiles.me/file.php?f=/game.part1.rar' },
        { label: 'FuckingFast Languages', group: 'languages', type: 'web', url: 'https://fuckingfast.co/files/game.languages.rar' }
    ];
    const sets = groupDownloadSets(links, 'fitgirl', {
        scoreHost: () => 1,
        shouldSplitRestrictedMultipart: () => true
    });

    assert.equal(normalizeDownloadSetHost('https://www.fuckingfast.com/files/game.part1.rar'), 'fuckingfast');
    assert.equal(normalizeDownloadSetHost('https://fileditchfiles.me/file.php?f=/game.part1.rar'), 'fileditchfiles.me');
    assert.deepEqual(sets.map(set => ({ host: set.host, group: set.group, parts: set.parts.length })), [
        { host: 'fuckingfast', group: 'game', parts: 3 },
        { host: 'fileditchfiles.me', group: 'game', parts: 1 },
        { host: 'fuckingfast', group: 'languages', parts: 1 }
    ]);
    assert.deepEqual(sets[0].parts.map(part => part.label), [
        'FuckingFast Part 1',
        'FuckingFast Part 2',
        'FuckingFast Part 3'
    ]);
});

test('restricted multipart splitting remains available for non-FitGirl sources', () => {
    const sets = groupDownloadSets([
        { label: 'FuckingFast Part 1', type: 'web', url: 'https://fuckingfast.co/files/game.part1.rar' },
        { label: 'FuckingFast Part 2', type: 'web', url: 'https://fuckingfast.net/files/game.part2.rar' }
    ], 'steamrip', {
        shouldSplitRestrictedMultipart: host => host === 'fuckingfast'
    });
    assert.deepEqual(sets.map(set => set.partLabel), ['Part 1', 'Part 2']);
    assert.deepEqual(sets.map(set => set.parts.length), [1, 1]);
});

test('download grouping rejects Telegram and other non-HTTPS source-page links', () => {
    const sets = groupDownloadSets([
        { label: 'VikingFile support', type: 'web', url: 'tg://resolve?domain=vikingfile_com' },
        { label: 'Rootz support', type: 'web', url: 'https://t.me/rootz_support' },
        { label: 'VikingFile', type: 'web', url: 'https://vikingfile.com/f/Live1234' },
        { label: 'Rootz', type: 'web', url: 'https://www.rootz.so/d/Live1234' }
    ], 'steamgg');
    assert.deepEqual(sets.map(set => set.host), ['vikingfile.com', 'rootz.so']);
    assert.equal(normalizeDownloadSetHost('tg://resolve?domain=vikingfile_com'), '');
    assert.equal(normalizeSteamRipDownloadUrl('https://vik1ngfile.site/f/Live1234'), 'https://vik1ngfile.site/f/Live1234');
    assert.equal(normalizeSteamRipDownloadUrl('https://www.rootz.so/d/Live1234'), 'https://www.rootz.so/d/Live1234');
});

test('SteamRIP result URLs do not require a free-download slug', () => {
    assert.equal(
        normalizeSteamRipResultUrl('cryberpunk-2k77-d7/'),
        'https://steamrip.com/cryberpunk-2k77-d7/'
    );
    assert.equal(normalizeSteamRipResultUrl('/'), '');
    assert.equal(normalizeSteamRipResultUrl('https://example.com/cyberpunk-2077/'), '');
});

test('SteamRIP card parsing executes the real Cyberpunk result branch', () => {
    const link = { getAttribute: name => name === 'href' ? 'cryberpunk-2k77-d7/' : '' };
    const title = { textContent: 'Cyberpunk 2077 Free Download (v2.31)' };
    const card = {
        classList: { contains: name => name === 'post-element' },
        querySelector(selector) {
            return selector === 'h2.thumb-title a[href], a.all-over-thumb-link[href]' ? link : title;
        }
    };
    const doc = {
        querySelector: selector => selector === '.main-content #masonry-grid' ? { children: [card] } : null
    };
    assert.deepEqual(parseSteamRipResults(doc, { imageForCard: () => 'cover.jpg' }), [{
        name: 'Cyberpunk 2077',
        url: 'https://steamrip.com/cryberpunk-2k77-d7/',
        image: 'cover.jpg'
    }]);
});

test('SteamRIP detail links expose a labeled GoFile mirror without exposing generic FileCrypt links', () => {
    const link = (href, afterLanguages = false, afterGofile = false) => ({
        afterLanguages,
        afterGofile,
        getAttribute: name => name === 'href' ? href : ''
    });
    const gofileMarker = {
        textContent: 'GOFILE',
        compareDocumentPosition: element => element.afterGofile ? 4 : 2
    };
    const languageMarker = {
        textContent: 'LANGUAGES',
        compareDocumentPosition: element => element.afterLanguages ? 4 : 2
    };
    const elements = [
        link('//bzzhr.to/u33dxmmaozb6'),
        link('//www.filecrypt.cc/Container/E779AE4ECB.html', false, true),
        link('//www.filecrypt.cc/Container/AAAAAAAAAA.html'),
        link('//fileditchfiles.me/file.php?f=/alpha4/Cbpunk-2ksvenseven-SteamRIP.com.rar'),
        link('//bzzhr.to/i1vc25zpcf17', true)
    ];
    const scope = {
        querySelectorAll(selector) {
            return selector === 'strong, h1, h2, h3, h4, h5, h6' ? [gofileMarker, languageMarker] : elements;
        }
    };
    const doc = { querySelector: () => scope };

    assert.deepEqual(parseSteamRipDownloadLinks(doc), [
        {
            label: 'BuzzHeavier',
            group: 'game',
            type: 'web',
            url: 'https://bzzhr.to/u33dxmmaozb6'
        },
        {
            label: 'GoFile',
            group: 'game',
            type: 'web',
            url: 'https://www.filecrypt.cc/Container/E779AE4ECB.html',
            resolverHost: 'gofile.io'
        },
        {
            label: 'FileDitch',
            group: 'game',
            type: 'web',
            url: 'https://fileditchfiles.me/file.php?f=/alpha4/Cbpunk-2ksvenseven-SteamRIP.com.rar'
        },
        {
            label: 'BuzzHeavier',
            group: 'languages',
            type: 'web',
            url: 'https://bzzhr.to/i1vc25zpcf17'
        }
    ]);
    assert.equal(normalizeSteamRipDownloadUrl('//www.filecrypt.cc/Container/example.html'), '');
    assert.equal(
        normalizeSteamRipGofileContainerUrl('//www.filecrypt.cc/Container/E779AE4ECB.html'),
        'https://www.filecrypt.cc/Container/E779AE4ECB.html'
    );
    assert.equal(normalizeSteamRipGofileContainerUrl('//www.filecrypt.cc/Link/E779AE4ECB.html'), '');
    assert.equal(normalizeSteamRipGofileContainerUrl('//ads.example/Container/E779AE4ECB.html'), '');
    assert.equal(steamRipDownloadHostLabel('https://bzzhr.to/example'), 'BuzzHeavier');
    assert.equal(steamRipDownloadHostLabel('https://fileditchfiles.me/file.php?f=game.rar'), 'FileDitch');
});

test('SteamRIP detail parsing recognizes a page with only a BuzzHeavier game link', () => {
    const element = { getAttribute: name => name === 'href' ? '//bzzhr.to/op1ye15r9ifp' : '' };
    const scope = {
        querySelectorAll: selector => selector === 'strong, h1, h2, h3, h4, h5, h6' ? [] : [element]
    };
    assert.deepEqual(parseSteamRipDownloadLinks({ querySelector: () => scope }), [{
        label: 'BuzzHeavier',
        group: 'game',
        type: 'web',
        url: 'https://bzzhr.to/op1ye15r9ifp'
    }]);
});

test('FitGirl lean results remain usable before covers arrive and exclude updates and pages', () => {
    const results = normalizeFitGirlPosts([
        {
            id: 1,
            type: 'post',
            link: 'https://fitgirl-repacks.site/liminal-shift/',
            categories: [5],
            title: { rendered: 'LIMINAL SHIFT' },
            sailReference: 'a'.repeat(48)
        },
        {
            id: 2,
            type: 'post',
            link: 'https://fitgirl-repacks.site/updates-digest/',
            categories: [42],
            title: { rendered: 'Updates Digest' },
            content: { rendered: '<img src="https://images.example/digest.jpg">' },
            sailReference: 'b'.repeat(48)
        },
        {
            id: 3,
            type: 'page',
            link: 'https://fitgirl-repacks.site/updates-list/',
            categories: [5],
            title: { rendered: 'Updates List' },
            content: { rendered: '<img src="https://images.example/list.jpg">' },
            sailReference: 'c'.repeat(48)
        }
    ]);

    assert.deepEqual(results, [{
        name: 'LIMINAL SHIFT',
        url: 'https://fitgirl-repacks.site/liminal-shift/',
        image: '',
        reference: 'a'.repeat(48)
    }]);
});

test('FitGirl cover enrichment accepts only exact FitGirl result permalinks', () => {
    assert.deepEqual(normalizeFitGirlPostCovers([
        {
            link: 'https://fitgirl-repacks.site/liminal-shift/',
            content: { rendered: '<p><img src="http://images.example/liminal-cover.jpg"></p>' }
        },
        {
            link: 'https://fitgirl-repacks.site.evil.example/liminal-shift/',
            content: { rendered: '<img src="https://evil.example/tracker.jpg">' }
        },
        {
            link: 'https://fitgirl-repacks.site/',
            content: { rendered: '<img src="https://images.example/home.jpg">' }
        }
    ]), [{
        url: 'https://fitgirl-repacks.site/liminal-shift/',
        image: 'https://images.example/liminal-cover.jpg'
    }]);
});

test('remote screenshots are upgraded to HTTPS and RiotPixels thumbnails resolve to full images', () => {
    const thumbnail = 'http://s01.riotpixels.net/data/6f/24/example.jpg.240p.jpg';
    assert.equal(
        normalizeRemoteImageUrl(thumbnail, 'https://fitgirl-repacks.site/game/'),
        'https://s01.riotpixels.net/data/6f/24/example.jpg.240p.jpg'
    );
    assert.equal(
        fullScreenshotImageUrl(thumbnail, 'https://fitgirl-repacks.site/game/'),
        'https://s01.riotpixels.net/data/6f/24/example.jpg'
    );
});

test('download source wiring stays within real result and screenshot sections', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(index, /searchDownloadSource\('fitgirl', query, page\)/);
    assert.match(index, /normalizeFitGirlPosts/);
    assert.match(index, /getFitGirlSearchCovers\(query, page\)/);
    assert.match(index, /normalizeFitGirlPostCovers/);
    assert.match(index, /batch\.coverPromise[\s\S]{0,500}const byUrl = new Map[\s\S]{0,500}card\.updateImage\(image\)/);
    assert.match(index, /parseSteamRipResults\(doc/);
    assert.match(index, /parseSteamRipDownloadLinks\(doc/);
    assert.match(index, /function dlKnownDownloadUrl\(value\)/);
    assert.match(index, /parsed\.protocol === 'https:'[\s\S]{0,220}DL_HOSTS\.test\(parsed\.hostname\)/);
    assert.match(index, /SteamRIP ranks matches[\s\S]{0,280}parseSteamRipResults/);
    assert.doesNotMatch(index, /filterSearchResultsByTitle/);
    assert.match(index, /pageCount: \(doc, currentPage\)/);
    assert.match(index, /id="downloadPagination"/);
    assert.match(index, /paginationWindow\(dlSearchState\.page, dlSearchState\.totalPages\)/);
    assert.match(index, /find\(node => \/\\bscreenshots\?\\b\/i/);
    assert.match(index, /fullScreenshotImageUrl/);
    assert.match(index, /className = 'dl-screenshot-viewer'/);
    assert.match(index, /className = 'dl-screenshot-viewer-nav previous'/);
    assert.match(index, /className = 'dl-screenshot-viewer-nav next'/);
    assert.match(index, /event\.key === 'ArrowLeft'[\s\S]{0,180}moveDownloadScreenshot\(-1\)/);
    assert.match(index, /event\.key === 'ArrowRight'[\s\S]{0,180}moveDownloadScreenshot\(1\)/);
    assert.match(index, /dlScreenshotItems\.forEach\(\(screenshot, index\)/);
    assert.match(index, /openDownloadScreenshot\(index, im\)/);
    assert.match(main, /resolveSteamMetadataForDownload\(opts\.gameName, opts\.sourceId\)/);
    assert.match(main, /steamAppId: steamMetadata && steamMetadata\.steamAppId/);
    assert.match(index, /myGames\.forEach\(game => DownloadSourceLogic\.repairDownloadedSteamGameMetadata\(game\)\)/);
    assert.doesNotMatch(index, /mirrorUrlsFor\s*\(/);
    assert.match(index, /languages\.textContent = 'Languages'/);
    assert.doesNotMatch(index, /const DL_HOSTS = [^\r\n]*filecrypt/i);
    const hostAllow = main.match(/const DL_HOST_ALLOW = [^\r\n]+/);
    assert.ok(hostAllow);
    assert.match(hostAllow[0], /fileditch/);
    assert.match(hostAllow[0], /bzzhr/);
    assert.doesNotMatch(hostAllow[0], /filecrypt/);
    assert.match(main, /const gofileContainer = normalizeFileCryptContainerUrl\(rawUrl\)/);
    assert.match(main, /if \(opts\.sourceId !== 'steamrip'\) return null/);
    assert.match(main, /captureResponseUrl:[\s\S]{0,500}captchasession/);
    assert.match(main, /return scrapeGofile\(location\)/);
});
