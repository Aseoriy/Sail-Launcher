'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    filterSearchResultsByTitle,
    fullScreenshotImageUrl,
    normalizeFitGirlPosts,
    normalizeRemoteImageUrl
} = require('../ui/downloadSourceLogic');

test('SteamRIP title filtering drops Popular and stop-word-only matches', () => {
    const results = filterSearchResultsByTitle([
        { name: 'Escape the Backrooms' },
        { name: 'Behind The Backrooms' },
        { name: 'Backrooms: Extractions' },
        { name: 'Dreamcore' },
        { name: 'Little Nightmares Enhanced Edition' },
        { name: "Assassin's Creed Black Flag Resynced" }
    ], 'escape the backrooms');

    assert.deepEqual(results.map(result => result.name), [
        'Escape the Backrooms',
        'Behind The Backrooms',
        'Backrooms: Extractions'
    ]);
});

test('FitGirl results retain game posts with covers and exclude updates and pages', () => {
    const results = normalizeFitGirlPosts([
        {
            id: 1,
            type: 'post',
            link: 'https://fitgirl-repacks.site/liminal-shift/',
            categories: [5],
            title: { rendered: 'LIMINAL SHIFT' },
            content: { rendered: '<p><img width="150" src="http://images.example/liminal-cover.jpg"></p>' },
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
        image: 'https://images.example/liminal-cover.jpg',
        reference: 'a'.repeat(48)
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
    assert.match(index, /searchDownloadSource\('fitgirl', query\)/);
    assert.match(index, /normalizeFitGirlPosts/);
    assert.match(index, /doc\.querySelector\('\.main-content #masonry-grid'\)/);
    assert.match(index, /grid\.children[\s\S]{0,160}post-element/);
    assert.match(index, /filterSearchResultsByTitle\(out, query\)/);
    assert.match(index, /find\(node => \/\\bscreenshots\?\\b\/i/);
    assert.match(index, /fullScreenshotImageUrl/);
    assert.match(index, /className = 'dl-screenshot-viewer'/);
});
