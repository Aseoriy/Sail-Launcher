'use strict';

// Plugin dependencies. A plugin names itself with an `id` in plugin.json and lists what it needs in
// `requires`: { "<id>": { "version": "<range>", "hub": "<Sail Hub item id>" } }. Sail starts plugins after
// what they need, keeps a plugin off while something it needs is missing, and can fetch a missing one from
// Sail Hub by its item id (never from a URL the plugin names).

const ID = /^[a-z0-9][a-z0-9-]{0,48}(?:\.[a-z0-9][a-z0-9-]{0,48}){1,3}$/;
const HUB_ITEM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,40}))?$/;
const RANGE = /^(\^|~|>=)?\s*(\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?)$/;
const MAX_REQUIREMENTS = 16;

function pluginId(manifest) {
    const value = String(manifest && manifest.id || '').trim();
    return ID.test(value) ? value : '';
}

function parseVersion(value) {
    const match = VERSION.exec(String(value || '').trim());
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] || '' };
}

function compareVersions(left, right) {
    for (const key of ['major', 'minor', 'patch']) if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
    // A release is newer than its pre-releases (1.0.0-beta.2 < 1.0.0).
    if (left.pre === right.pre) return 0;
    if (!left.pre) return 1;
    if (!right.pre) return -1;
    const a = left.pre.split('.'), b = right.pre.split('.');
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        if (a[index] === undefined) return -1;
        if (b[index] === undefined) return 1;
        const numeric = /^\d+$/.test(a[index]) && /^\d+$/.test(b[index]);
        const order = numeric ? Number(a[index]) - Number(b[index]) : a[index].localeCompare(b[index]);
        if (order) return order < 0 ? -1 : 1;
    }
    return 0;
}

// Ranges: exact (1.2.0), caret (^1.2.0: same major), tilde (~1.2.0: same minor), at least (>=1.2.0).
function satisfies(versionText, rangeText) {
    const range = String(rangeText || '').trim();
    if (!range || range === '*') return true;
    const version = parseVersion(versionText), match = RANGE.exec(range);
    if (!version || !match) return false;
    const base = parseVersion(match[2]), operator = match[1] || '';
    const order = compareVersions(version, base);
    if (operator === '') return order === 0;
    if (order < 0) return false;
    if (operator === '>=') return true;
    if (operator === '^') return base.major > 0 ? version.major === base.major : version.major === 0 && version.minor === base.minor;
    return version.major === base.major && version.minor === base.minor;
}

function validRange(rangeText) {
    const range = String(rangeText || '').trim();
    return !range || range === '*' || RANGE.test(range);
}

// The requirements a manifest declares, plus any it declares wrongly (shown to the user, never guessed at).
function requirements(manifest) {
    const declared = manifest && manifest.requires;
    const list = [], problems = [];
    if (declared === undefined || declared === null) return { list, problems };
    if (typeof declared !== 'object' || Array.isArray(declared)) return { list, problems: ['"requires" must be an object.'] };
    const own = pluginId(manifest);
    for (const [id, value] of Object.entries(declared).slice(0, MAX_REQUIREMENTS + 1)) {
        if (list.length >= MAX_REQUIREMENTS) { problems.push(`At most ${MAX_REQUIREMENTS} requirements are allowed.`); break; }
        const entry = typeof value === 'string' ? { version: value } : value;
        if (!ID.test(id)) { problems.push(`"${String(id).slice(0, 60)}" is not a valid plugin id.`); continue; }
        if (id === own) { problems.push('A plugin cannot require itself.'); continue; }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { problems.push(`The requirement for ${id} is invalid.`); continue; }
        if (!validRange(entry.version)) { problems.push(`The version range for ${id} is invalid.`); continue; }
        if (entry.hub !== undefined && !HUB_ITEM.test(String(entry.hub))) { problems.push(`The Sail Hub item for ${id} is invalid.`); continue; }
        list.push({ id, range: String(entry.version || '').trim(), hub: entry.hub ? String(entry.hub).toLowerCase() : '' });
    }
    return { list, problems };
}

// Works out, for every installed plugin, what it is missing and the order to start them in.
// `plugins` entries: { key, manifest, enabled } where enabled means installed, supported and not switched off.
function resolve(plugins) {
    const byId = new Map();
    for (const plugin of plugins) {
        const id = pluginId(plugin.manifest);
        if (id && !byId.has(id)) byId.set(id, plugin);
    }
    const state = new Map();
    const visiting = new Set();
    function check(plugin) {
        if (state.has(plugin.key)) return state.get(plugin.key);
        const { list, problems } = requirements(plugin.manifest);
        const unmet = problems.map(problem => ({ reason: 'invalid', message: problem }));
        if (visiting.has(plugin.key)) return { unmet: [{ reason: 'cycle', message: 'These plugins require each other.' }] };
        visiting.add(plugin.key);
        for (const requirement of list) {
            const provider = byId.get(requirement.id);
            if (!provider) { unmet.push({ ...requirement, reason: 'missing' }); continue; }
            const version = String(provider.manifest.version || '');
            if (!satisfies(version, requirement.range)) { unmet.push({ ...requirement, reason: 'version', installed: version, name: provider.manifest.name }); continue; }
            if (!provider.enabled) { unmet.push({ ...requirement, reason: 'disabled', name: provider.manifest.name, key: provider.key }); continue; }
            const inner = check(provider);
            if (inner.unmet.length) unmet.push({ ...requirement, reason: 'unmet', name: provider.manifest.name, key: provider.key });
        }
        visiting.delete(plugin.key);
        const result = { unmet };
        state.set(plugin.key, result);
        return result;
    }
    for (const plugin of plugins) check(plugin);
    // Start what others need first: a plugin starts after every plugin it requires.
    const order = [], placed = new Set();
    function place(plugin) {
        if (placed.has(plugin.key)) return;
        placed.add(plugin.key);
        for (const requirement of requirements(plugin.manifest).list) {
            const provider = byId.get(requirement.id);
            if (provider) place(provider);
        }
        order.push(plugin.key);
    }
    for (const plugin of plugins) place(plugin);
    return { unmet: new Map([...state].map(([key, value]) => [key, value.unmet])), order };
}

// Installed plugins that list `id` in their requirements.
function dependentsOf(id, plugins) {
    if (!id) return [];
    return plugins.filter(plugin => requirements(plugin.manifest).list.some(requirement => requirement.id === id));
}

function describeUnmet(item) {
    const range = item.range && item.range !== '*' ? ` ${describeRange(item.range)}` : '';
    const name = item.name || item.id;
    if (item.reason === 'missing') return `Needs ${name}${range}`;
    if (item.reason === 'version') return `Needs ${name}${range} (${item.installed || 'unknown'} is installed)`;
    if (item.reason === 'disabled') return `Needs ${name}, which is turned off`;
    if (item.reason === 'unmet') return `Needs ${name}, which is missing something itself`;
    return item.message || 'Has an invalid requirement';
}

function describeRange(range) {
    const match = RANGE.exec(String(range || '').trim());
    if (!match) return '';
    const operator = match[1] || '';
    if (operator === '>=') return `${match[2]} or newer`;
    if (operator === '^') return `${match[2]} or a newer ${match[2].split('.')[0]}.x`;
    if (operator === '~') return `${match[2]} or a newer ${match[2].split('.').slice(0, 2).join('.')}.x`;
    return match[2];
}

// Layout packs are data only (a manifest, CSS and images). Sail never runs anything from one.
function layoutPackProblem(manifest) {
    if (!manifest || manifest.type !== 'layout') return '';
    if (manifest.main) return 'Layout packs cannot contain code.';
    if (!pluginId(manifest)) return 'Layout packs need a valid "id" in plugin.json.';
    return '';
}

module.exports = { HUB_ITEM, compareVersions, dependentsOf, describeRange, describeUnmet, layoutPackProblem, parseVersion, pluginId, requirements, resolve, satisfies };
