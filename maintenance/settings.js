'use strict';

function normalizeSettings(target, defaults) {
    const current = target && typeof target === 'object' ? target : {};
    for (const [key, value] of Object.entries(defaults || {})) {
        if (current[key] === undefined) current[key] = Array.isArray(value) ? value.slice() : value;
    }
    return current;
}

module.exports = { normalizeSettings };
