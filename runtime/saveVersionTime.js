'use strict';

// Save version files are named with a UTC stamp (2026-11-11T11-05-12) so they sort the same everywhere.
// People read the list in their own time zone.
function localSaveVersionTime(stamp) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/.exec(String(stamp || ''));
    if (!match) return null;
    const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]));
    if (Number.isNaN(date.getTime())) return null;
    const two = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

module.exports = { localSaveVersionTime };
