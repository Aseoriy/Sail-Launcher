'use strict';

// Per-plugin settings. A plugin lists the options it has in plugin.json ("settings": [...]); Sail draws the dialog,
// keeps the values on this PC and hands the plugin a small object to read them and react when they change.
//
//   { "id": "colors",  "type": "toggle", "label": "Steam colours", "description": "...", "default": true }
//   { "id": "buttons", "type": "select", "label": "Action buttons", "default": "menu",
//     "options": [{ "value": "menu", "label": "In the menu bar" }, { "value": "header", "label": "On the page" }] }
//   { "id": "count",   "type": "number", "label": "Games shown", "default": 5, "min": 1, "max": 10, "step": 1, "slider": true }
//   { "id": "name",    "type": "text",   "label": "Nickname", "default": "", "maxLength": 40 }
//   { "type": "heading", "label": "Appearance" }

const TYPES = new Set(['toggle', 'select', 'number', 'text', 'heading']);
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const LIMITS = { fields: 64, options: 50, label: 120, description: 400, text: 500, optionValue: 80 };

const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const finite = value => typeof value === 'number' && Number.isFinite(value);

// Turns whatever a manifest holds into a list of fields that are safe to draw and to store against.
function normalizeSchema(raw) {
    if (!Array.isArray(raw)) return [];
    const fields = [];
    const seen = new Set();
    for (const entry of raw) {
        if (fields.length >= LIMITS.fields) break;
        if (!entry || typeof entry !== 'object' || !TYPES.has(entry.type)) continue;
        const label = text(entry.label, LIMITS.label);
        if (entry.type === 'heading') { if (label) fields.push({ type: 'heading', label }); continue; }
        if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id) || seen.has(entry.id) || !label) continue;
        const field = { id: entry.id, type: entry.type, label, description: text(entry.description, LIMITS.description) };
        if (entry.type === 'toggle') {
            field.default = entry.default === true;
        } else if (entry.type === 'select') {
            field.options = (Array.isArray(entry.options) ? entry.options : [])
                .slice(0, LIMITS.options)
                .map(option => option && typeof option === 'object'
                    ? { value: text(String(option.value ?? ''), LIMITS.optionValue), label: text(String(option.label ?? option.value ?? ''), LIMITS.label) }
                    : null)
                .filter(option => option && option.value && option.label);
            if (!field.options.length) continue;
            field.default = field.options.some(option => option.value === entry.default) ? entry.default : field.options[0].value;
        } else if (entry.type === 'number') {
            field.min = finite(entry.min) ? entry.min : 0;
            field.max = finite(entry.max) && entry.max >= field.min ? entry.max : Math.max(field.min, 100);
            field.step = finite(entry.step) && entry.step > 0 ? entry.step : 1;
            field.slider = entry.slider === true;
            field.default = coerceValue({ type: 'number', min: field.min, max: field.max, step: field.step, default: field.min }, entry.default);
        } else {
            field.maxLength = finite(entry.maxLength) ? Math.max(1, Math.min(LIMITS.text, Math.floor(entry.maxLength))) : 200;
            field.default = text(typeof entry.default === 'string' ? entry.default : '', field.maxLength);
        }
        seen.add(field.id);
        fields.push(field);
    }
    return fields;
}

// Returns a value that is valid for the field. Anything that is not falls back to the field's default.
function coerceValue(field, value) {
    switch (field.type) {
        case 'toggle':
            return typeof value === 'boolean' ? value : field.default === true;
        case 'select':
            return field.options.some(option => option.value === value) ? value : field.default;
        case 'number': {
            const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
            if (!finite(number)) return finite(field.default) ? field.default : field.min;
            const stepped = Math.round((number - field.min) / field.step) * field.step + field.min;
            const places = (String(field.step).split('.')[1] || '').length;
            return Number(Math.min(field.max, Math.max(field.min, stepped)).toFixed(places));
        }
        case 'text':
            return typeof value === 'string' ? value.slice(0, field.maxLength) : field.default;
        default:
            return undefined;
    }
}

// Folder names come from disk; keep the settings file inside the settings folder whatever the name is.
function fileNameFor(folder) {
    const name = String(folder || '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
    return name && name.length <= 120 ? `${name}.json` : '';
}

function createPluginSettingsStore({ fs, path, getDirectory, setTimer = setTimeout, clearTimer = clearTimeout, delay = 150 }) {
    const entries = new Map();
    const pending = new Set();
    let timer = null;

    function fileFor(folder) {
        const directory = getDirectory();
        const name = fileNameFor(folder);
        return directory && name ? path.join(directory, name) : '';
    }
    function load(folder) {
        const file = fileFor(folder);
        if (!file) return {};
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            return parsed && typeof parsed === 'object' && parsed.values && typeof parsed.values === 'object' && !Array.isArray(parsed.values) ? { ...parsed.values } : {};
        } catch (_) { return {}; /* Missing or damaged: start from the defaults. The file is only replaced when something is changed. */ }
    }
    function write(folder) {
        const entry = entries.get(folder);
        const file = fileFor(folder);
        if (!entry || !file) return;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const temporary = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(temporary, JSON.stringify({ version: 1, values: entry.values }, null, 2));
            fs.renameSync(temporary, file);
        } catch (error) { console.error('[Plugin settings] Could not save settings for', folder, error); }
    }
    function schedule(folder) {
        pending.add(folder);
        if (timer) return;
        timer = setTimer(flush, delay);
    }
    function flush() {
        if (timer) { clearTimer(timer); timer = null; }
        for (const folder of Array.from(pending)) write(folder);
        pending.clear();
    }
    function entryFor(folder) {
        if (!entries.has(folder)) entries.set(folder, { schema: [], values: load(folder), listeners: new Set(), observers: new Set() });
        return entries.get(folder);
    }
    const fieldOf = (entry, id) => entry.schema.find(field => field.id === id && field.type !== 'heading');

    // Called whenever a plugin is (re)discovered: its manifest decides which options exist.
    function register(folder, rawSchema) {
        const entry = entryFor(folder);
        entry.schema = normalizeSchema(rawSchema);
        return entry.schema;
    }
    const schema = folder => (entries.get(folder) || { schema: [] }).schema;
    const hasSettings = folder => schema(folder).some(field => field.type !== 'heading');

    function announce(entry, id) {
        const field = fieldOf(entry, id);
        if (!field) return;
        const value = valueOf(entry, field);
        const all = allOf(entry);
        for (const listener of Array.from(entry.listeners)) { try { listener(id, value, all); } catch (error) { console.error('[Plugin settings] listener failed', error); } }
        for (const observer of Array.from(entry.observers)) { try { observer(id, value, all); } catch (error) { console.error('[Plugin settings] observer failed', error); } }
    }
    const valueOf = (entry, field) => Object.prototype.hasOwnProperty.call(entry.values, field.id) ? coerceValue(field, entry.values[field.id]) : field.default;
    const allOf = entry => Object.fromEntries(entry.schema.filter(field => field.type !== 'heading').map(field => [field.id, valueOf(entry, field)]));

    function set(folder, id, value) {
        const entry = entryFor(folder);
        const field = fieldOf(entry, id);
        if (!field) return false;
        const next = coerceValue(field, value);
        if (valueOf(entry, field) === next && Object.prototype.hasOwnProperty.call(entry.values, id)) return true;
        entry.values[id] = next;
        schedule(folder);
        announce(entry, id);
        return true;
    }
    function reset(folder, id) {
        const entry = entryFor(folder);
        const ids = id === undefined ? entry.schema.filter(field => field.type !== 'heading').map(field => field.id) : [id];
        for (const key of ids) {
            if (!fieldOf(entry, key) || !Object.prototype.hasOwnProperty.call(entry.values, key)) continue;
            delete entry.values[key];
            schedule(folder);
            announce(entry, key);
        }
    }

    // What a plugin receives. `extras` lets the launcher add things such as open().
    function controller(folder, extras = {}) {
        const entry = entryFor(folder);
        return {
            get: id => { const field = fieldOf(entry, id); return field ? valueOf(entry, field) : undefined; },
            getAll: () => allOf(entry),
            set: (id, value) => set(folder, id, value),
            reset: id => reset(folder, id),
            isSet: id => !!fieldOf(entry, id) && Object.prototype.hasOwnProperty.call(entry.values, id),
            onChange: callback => { if (typeof callback !== 'function') return () => {}; entry.listeners.add(callback); return () => entry.listeners.delete(callback); },
            ...extras
        };
    }
    // The settings dialog watches a plugin too, so it can redraw when the plugin changes a value itself.
    function observe(folder, callback) { const entry = entryFor(folder); entry.observers.add(callback); return () => entry.observers.delete(callback); }
    // A plugin that is stopped or reloaded must not keep receiving changes.
    function dropListeners(folder) { const entry = entries.get(folder); if (entry) entry.listeners.clear(); }
    function remove(folder) {
        flush();
        entries.delete(folder);
        const file = fileFor(folder);
        try { if (file) fs.rmSync(file, { force: true }); } catch (error) { console.error('[Plugin settings] Could not remove settings for', folder, error); }
    }
    return { register, schema, hasSettings, controller, observe, dropListeners, remove, flush, set, reset, get: (folder, id) => controller(folder).get(id), getAll: folder => allOf(entryFor(folder)) };
}

// Draws the controls for one plugin into a container. Every change is saved straight away.
function renderPluginSettingsForm(doc, container, store, folder) {
    const make = (tag, props = {}, children = []) => {
        const node = doc.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (value === undefined || value === null || value === false) continue;
            if (key === 'text') node.textContent = value;
            else if (key === 'class') node.className = value;
            else node.setAttribute(key, value === true ? '' : String(value));
        }
        for (const child of [].concat(children)) if (child) node.append(child);
        return node;
    };
    const controls = new Map();
    const values = store.getAll(folder);
    const rows = store.schema(folder).map(field => {
        if (field.type === 'heading') return make('h4', { class: 'plugin-setting-heading', text: field.label });
        const hint = field.description ? make('small', { class: 'plugin-setting-hint', text: field.description }) : null;
        const id = `pluginSetting-${field.id}`;
        let input;
        let row;
        if (field.type === 'toggle') {
            input = make('input', { type: 'checkbox', id });
            input.checked = values[field.id] === true;
            input.addEventListener('change', () => store.set(folder, field.id, input.checked));
            row = make('label', { class: 'toggle-label plugin-setting', for: id }, [input, make('div', { class: 'toggle-switch' }), make('span', {}, [make('span', { class: 'plugin-setting-label', text: field.label }), hint])]);
        } else if (field.type === 'select') {
            input = make('select', { id }, field.options.map(option => make('option', { value: option.value, text: option.label })));
            input.value = values[field.id];
            input.addEventListener('change', () => store.set(folder, field.id, input.value));
            row = make('div', { class: 'plugin-setting' }, [make('label', { class: 'plugin-setting-label', for: id, text: field.label }), hint, input]);
        } else if (field.type === 'number') {
            input = make('input', { type: field.slider ? 'range' : 'number', id, min: field.min, max: field.max, step: field.step });
            input.value = values[field.id];
            const readout = make('span', { class: 'plugin-setting-readout', text: String(values[field.id]) });
            input.addEventListener('input', () => { readout.textContent = input.value; });
            input.addEventListener('change', () => { store.set(folder, field.id, Number(input.value)); input.value = store.get(folder, field.id); readout.textContent = input.value; });
            row = make('div', { class: 'plugin-setting' }, [make('label', { class: 'plugin-setting-label', for: id, text: field.label }), hint, make('div', { class: 'plugin-setting-number' }, [input, field.slider ? readout : null])]);
        } else {
            input = make('input', { type: 'text', id, maxlength: field.maxLength, spellcheck: 'false' });
            input.value = values[field.id];
            input.addEventListener('change', () => { store.set(folder, field.id, input.value); input.value = store.get(folder, field.id); });
            row = make('div', { class: 'plugin-setting' }, [make('label', { class: 'plugin-setting-label', for: id, text: field.label }), hint, input]);
        }
        controls.set(field.id, input);
        return row;
    });
    container.replaceChildren(...rows);
    // Keep the controls in step when the plugin (or a reset) changes a value.
    const stop = store.observe(folder, (id, value) => {
        const input = controls.get(id);
        if (!input || doc.activeElement === input) return;
        if (input.type === 'checkbox') input.checked = value === true; else input.value = value;
        const readout = input.parentElement && input.parentElement.querySelector('.plugin-setting-readout');
        if (readout) readout.textContent = String(value);
    });
    return { destroy: stop };
}

module.exports = { normalizeSchema, coerceValue, fileNameFor, createPluginSettingsStore, renderPluginSettingsForm, LIMITS };
