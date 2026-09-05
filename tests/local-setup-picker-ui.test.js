'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function sourceBetween(startMarker, endMarker) {
    const start = index.indexOf(startMarker);
    const end = index.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0, `Missing production source: ${startMarker}`);
    assert.ok(end > start, `Missing production source boundary: ${endMarker}`);
    return index.slice(start, end).trim();
}

class MiniClassList {
    constructor(initial = []) { this.values = new Set(initial); }
    add(...values) { values.forEach(value => this.values.add(value)); }
    remove(...values) { values.forEach(value => this.values.delete(value)); }
    contains(value) { return this.values.has(value); }
}

class MiniElement {
    constructor(id, classes = []) {
        this.id = id;
        this.value = '';
        this.placeholder = '';
        this.disabled = false;
        this.innerHTML = '';
        this.textContent = '';
        this.style = {};
        this.attributes = new Map();
        this.listeners = new Map();
        this.classList = new MiniClassList(classes);
        this.checked = false;
    }

    addEventListener(type, listener) {
        const list = this.listeners.get(type) || [];
        list.push(listener);
        this.listeners.set(type, list);
    }

    async dispatch(type, event = {}) {
        const input = Object.assign({ preventDefault() {}, stopPropagation() {} }, event);
        for (const listener of this.listeners.get(type) || []) await listener(input);
    }

    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.get(name) || null; }
    append() {}
    appendChild() {}
    replaceChildren() {}
}

function makeDocument(ids) {
    const elements = new Map(ids.map(id => [id, new MiniElement(id)]));
    const document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, new MiniElement(id));
            return elements.get(id);
        },
        querySelectorAll() { return []; },
        createElement(tag) { return new MiniElement(tag); }
    };
    return { document, elements };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

const PICKER_FUNCTIONS = [
    sourceBetween('function updateLocalSetupPickerUi()', 'async function browseLocalSetupSelection('),
    sourceBetween('async function browseLocalSetupSelection(', "document.getElementById('browsePlayDetectionBtn').addEventListener"),
    sourceBetween("document.getElementById('browsePlayDetectionBtn').addEventListener", 'window.browseQuickPath')
].join('\n');

function createPickerHarness() {
    const { document, elements } = makeDocument([
        'saveBtn', 'browsePlayDetectionBtn', 'browseLocalBtn', 'addModal', 'localSave',
        'playDetectionPath', 'saveDetectionCandidates'
    ]);
    elements.get('addModal').classList.add('show');
    const calls = [];
    const alerts = [];
    let nextInvoke = null;
    const invokeAccount = (channel, payload) => {
        calls.push({ channel, payload });
        if (!nextInvoke) return Promise.resolve({ canceled: true });
        const result = nextInvoke;
        nextInvoke = null;
        return result;
    };
    const context = vm.createContext({
        document,
        invokeAccount,
        sailAlert: async message => alerts.push(String(message)),
        console: { error() {} }
    });
    const api = vm.runInContext(`(() => {
        let localAuthorityDraft = {
            execution: false, save: false, tracking: false, companion: false,
            executableSelectionId: '', saveSelectionId: '', trackingSelectionId: ''
        };
        let editingIndex = 0;
        const myGames = [{ id: 'existing-game' }];
        let activeSaveDetectionScanId = '';
        ${PICKER_FUNCTIONS}
        return {
            browseLocalSetupSelection,
            updateLocalSetupPickerUi,
            getDraft: () => localAuthorityDraft,
            replaceDraft: value => { localAuthorityDraft = value; }
        };
    })()`, context);
    return {
        ...api,
        elements,
        calls,
        alerts,
        resolveNext(value) { nextInvoke = Promise.resolve(value); },
        rejectNext(error) { nextInvoke = Promise.reject(error); },
        async dispatch(id, type = 'click') { await elements.get(id).dispatch(type); }
    };
}

test('Browse uses purpose-specific selection IPC and stores only opaque ids until Save', async () => {
    const env = createPickerHarness();
    const selection = deferred();
    env.resolveNext(selection.promise);
    const trackingBrowse = env.browseLocalSetupSelection('tracking');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(plain(env.calls[0]), {
        channel: 'authority-select-executable',
        payload: { purpose: 'tracking', gameId: 'existing-game' }
    });
    assert.equal(env.elements.get('browsePlayDetectionBtn').disabled, true);
    selection.resolve({ selectionId: 'opaque-tracking', label: 'Tracking executable selected' });
    await trackingBrowse;
    assert.equal(env.getDraft().trackingSelectionId, 'opaque-tracking');
    assert.equal(env.getDraft().execution, false, 'tracking-only edits must not request execution');
    assert.equal(env.elements.get('playDetectionPath').value, 'Tracking executable selected — Save to apply');
    assert.equal(Object.prototype.hasOwnProperty.call(env.getDraft(), 'path'), false);

    const saveSelection = deferred();
    env.resolveNext(saveSelection.promise);
    const saveBrowse = env.browseLocalSetupSelection('save');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(plain(env.calls[1]), {
        channel: 'authority-select-filesystem',
        payload: { kind: 'save', pathKind: 'folder', gameId: 'existing-game' }
    });
    saveSelection.resolve({ selectionId: 'opaque-save', label: 'Save folder selected' });
    await saveBrowse;
    assert.equal(env.getDraft().saveSelectionId, 'opaque-save');
    assert.equal(env.getDraft().execution, false);
    assert.equal(env.elements.get('localSave').value, 'Save folder selected — Save to apply');
});

test('picker cancellation and errors preserve prior selection and clear pending state', async () => {
    const env = createPickerHarness();
    const draft = env.getDraft();
    draft.tracking = true;
    draft.trackingSelectionId = 'prior-tracking';
    draft.save = true;
    draft.saveSelectionId = 'prior-save';

    env.resolveNext({ canceled: true });
    await env.browseLocalSetupSelection('tracking');
    assert.equal(draft.trackingSelectionId, 'prior-tracking');
    assert.equal(draft.tracking, true);
    assert.equal(draft.trackingSelectionPending, null);

    env.rejectNext(new Error('picker unavailable'));
    await env.browseLocalSetupSelection('save');
    assert.equal(draft.saveSelectionId, 'prior-save');
    assert.equal(draft.save, true);
    assert.equal(draft.saveSelectionPending, null);
    assert.deepEqual(env.alerts, ['picker unavailable']);
});

test('stale picker results are ignored after the form draft changes', async () => {
    const env = createPickerHarness();
    const selection = deferred();
    env.resolveNext(selection.promise);
    const pendingBrowse = env.browseLocalSetupSelection('tracking');
    await new Promise(resolve => setImmediate(resolve));
    const replacement = {
        execution: false, save: false, tracking: false, companion: false,
        executableSelectionId: '', saveSelectionId: '', trackingSelectionId: ''
    };
    env.replaceDraft(replacement);
    selection.resolve({ selectionId: 'stale-selection', label: 'Stale' });
    await pendingBrowse;
    assert.equal(replacement.trackingSelectionId, '', 'late result must not enter the replacement draft');
    assert.equal(replacement.tracking, false);
});

const SAVE_LISTENER = sourceBetween(
    "document.getElementById('saveBtn').addEventListener('click', async () => {",
    'window.editGame'
);

function createSaveHarness({ failureChannel = '' } = {}) {
    const { document, elements } = makeDocument([
        'saveBtn', 'gameName', 'platformSelect', 'steamAppId', 'epicId', 'gogId', 'romToggle',
        'customBannerPath', 'shortcutIconPath', 'romArgs', 'addModal'
    ]);
    elements.get('addModal').classList.add('show');
    elements.get('gameName').value = 'Existing Game';
    elements.get('platformSelect').value = 'steam';
    elements.get('steamAppId').value = '12345';
    const calls = [];
    let closeCount = 0;
    const alerts = [];
    const existingGame = {
        id: 'existing-game', name: 'Existing Game', platform: 'steam', steamAppId: '12345',
        isFavorite: true, addedAt: 1, playtime: 4, playtimeSessionIds: [], tags: []
    };
    const invokeAccount = async (channel, payload) => {
        calls.push({ channel, payload });
        if (channel === failureChannel) throw new Error('setup failed');
        if (channel === 'profiles-load-active') return { myGames: [existingGame], customSections: [] };
        return {};
    };
    const context = vm.createContext({
        document,
        invokeAccount,
        remoteData: {
            getSteamAppDetails: async id => ({ [id]: { success: true, data: { name: 'Existing Game', header_image: '' } } })
        },
        sailAlert: async message => alerts.push(String(message)),
        closeModal: () => { closeCount += 1; },
        applyLauncherSnapshot() {},
        openGamePage() {},
        console: { error() {} },
        Date,
        Math
    });
    const api = vm.runInContext(`(() => {
        let localAuthorityDraft = {
            execution: false, save: false, tracking: false, companion: false,
            executableSelectionId: '', saveSelectionId: '', trackingSelectionId: ''
        };
        let editingIndex = 0;
        let viewingGameIndex = null;
        let myGames = [${JSON.stringify(existingGame)}];
        let customSections = [];
        let globalSettings = { language: 'english' };
        let gameConfigEntriesDraft = [];
        function updateLocalSetupPickerUi() {}
        function portableGameConfigEntry(entry) { return entry; }
        ${SAVE_LISTENER}
        return {
            getDraft: () => localAuthorityDraft,
            setDraft: value => { localAuthorityDraft = value; },
            click: () => document.getElementById('saveBtn').dispatch('click')
        };
    })()`, context);
    return { ...api, elements, calls, alerts, get closeCount() { return closeCount; }, existingGame };
}

test('Save is blocked while a local picker is pending', async () => {
    const env = createSaveHarness();
    env.getDraft().saveSelectionPending = {};
    await env.click();
    assert.deepEqual(env.calls, []);
    assert.equal(env.closeCount, 0);
});

test('existing tracking-only edits use tracking authority and preserve execution', async () => {
    const env = createSaveHarness();
    env.setDraft({
        execution: false, save: false, tracking: true, companion: false,
        executableSelectionId: '', saveSelectionId: '', trackingSelectionId: 'opaque-track'
    });
    await env.click();
    const tracking = env.calls.find(call => call.channel === 'authority-configure-tracking');
    assert.deepEqual(plain(tracking), {
        channel: 'authority-configure-tracking',
        payload: { gameId: 'existing-game', selectionId: 'opaque-track' }
    });
    assert.equal(env.calls.some(call => call.channel === 'authority-configure-execution'), false);
    assert.equal(env.calls.some(call => call.channel === 'authority-configure-steam'), false);
    assert.equal(env.closeCount, 1);
});

test('Save passes an existing save selection id without opening a second picker', async () => {
    const env = createSaveHarness();
    env.setDraft({
        execution: false, save: true, tracking: false, companion: false,
        executableSelectionId: '', saveSelectionId: 'opaque-save', trackingSelectionId: ''
    });
    await env.click();
    const save = env.calls.find(call => call.channel === 'authority-configure-filesystem');
    assert.deepEqual(plain(save), {
        channel: 'authority-configure-filesystem',
        payload: { gameId: 'existing-game', kind: 'save', entryId: '', pathKind: 'folder', selectionId: 'opaque-save' }
    });
    assert.equal(env.calls.some(call => call.channel === 'authority-select-filesystem'), false);
});

test('setup failure keeps the dialog open and does not claim completion', async () => {
    const env = createSaveHarness({ failureChannel: 'authority-configure-tracking' });
    env.setDraft({
        execution: false, save: false, tracking: true, companion: false,
        executableSelectionId: '', saveSelectionId: '', trackingSelectionId: 'opaque-track'
    });
    await env.click();
    assert.equal(env.closeCount, 0);
    assert.deepEqual(env.alerts, ['setup failed']);
    assert.equal(env.elements.get('addModal').classList.contains('show'), true);
});

const AUTO_SAVE = sourceBetween('window.runAutoSaveDetection = async function()', 'window.selectSteamSearchResult');
const OVERRIDE_HANDLER = sourceBetween(
    "document.getElementById('overrideSaveBtn').addEventListener('click', (e) => {",
    "document.getElementById('steamAppId').addEventListener('input'"
);

function createAutoScanHarness() {
    const { document, elements } = makeDocument([
        'steamAppId', 'gameName', 'browseLocalBtn', 'localSave', 'saveDetectionCandidates',
        'overrideSaveBtn', 'addModal', 'browsePlayDetectionBtn', 'saveBtn'
    ]);
    elements.get('addModal').classList.add('show');
    elements.get('steamAppId').value = '12345';
    elements.get('gameName').value = 'Existing Game';
    const scan = deferred();
    const manual = deferred();
    const rendered = [];
    const calls = [];
    const ipcRenderer = { invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        if (channel === 'detect-saves-auto') return scan.promise;
        throw new Error('unexpected IPC');
    } };
    const invokeAccount = (channel, payload) => {
        calls.push({ channel, payload });
        return manual.promise;
    };
    const context = vm.createContext({
        document,
        ipcRenderer,
        invokeAccount,
        globalSettings: { enableSaveDetection: true, saveDetectionMode: 'auto' },
        remoteData: {},
        myGames: [],
        editingIndex: -1,
        setSaveDetectionScanStatus() {},
        renderSaveDetectionCandidates: (...args) => rendered.push(args),
        console: { error() {} },
        window: {}
    });
    const api = vm.runInContext(`(() => {
        let localAuthorityDraft = {
            execution: false, save: false, tracking: false, companion: false,
            executableSelectionId: '', saveSelectionId: '', trackingSelectionId: ''
        };
        let saveDetectionOverridden = false;
        let saveDetectionScanToken = 0;
        let activeSaveDetectionScanId = '';
        let saveDetectionScanId = '';
        function updateSaveDetectionUI() {}
        function executionAuthorityReference() { throw new Error('not expected'); }
        ${sourceBetween('function updateLocalSetupPickerUi()', 'async function browseLocalSetupSelection(')}
        ${sourceBetween('async function browseLocalSetupSelection(', "document.getElementById('browsePlayDetectionBtn').addEventListener")}
        ${AUTO_SAVE}
        const runAutoSaveDetection = window.runAutoSaveDetection;
        ${OVERRIDE_HANDLER}
        return {
            runAutoSaveDetection,
            browseLocalSetupSelection,
            getDraft: () => localAuthorityDraft
        };
    })()`, context);
    return {
        ...api, elements, calls, rendered, scan, manual,
        async click(id) { await elements.get(id).dispatch('click'); }
    };
}

test('Override cancels late auto-scan results and preserves a manual selection', async () => {
    const env = createAutoScanHarness();
    const auto = env.runAutoSaveDetection();
    await new Promise(resolve => setImmediate(resolve));
    await env.click('overrideSaveBtn');
    const browse = env.browseLocalSetupSelection('save');
    await new Promise(resolve => setImmediate(resolve));
    env.manual.resolve({ selectionId: 'manual-save', label: 'Manual folder selected' });
    await browse;
    env.scan.resolve({ candidates: [{ label: 'Late automatic candidate', path: 'never-expose' }] });
    await auto;
    assert.equal(env.getDraft().saveSelectionId, 'manual-save');
    assert.equal(env.elements.get('localSave').value, 'Manual folder selected — Save to apply');
    assert.equal(env.rendered.length, 0, 'stale automatic results must not replace manual selection');
});
