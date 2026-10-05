'use strict';
const { validateDllOverrides } = require('../runtime/proton/environment');
function parseProtonLaunchOptions(text, overrides = '') {
    const value = String(text || '').trim();
    const steam = /^WINEDLLOVERRIDES=(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+))\s+%command%\s*$/.exec(value);
    if (steam) {
        const selected = validateDllOverrides(steam[1] ?? steam[2] ?? steam[3]);
        if (overrides && overrides !== selected) throw Error('The launch options and DLL overrides field disagree. Keep the override in one field.');
        return { argv: [], dllOverrides: selected };
    }
    let argv;
    try { argv = JSON.parse(value || '[]'); }
    catch { throw Error('Enter a JSON argument array, such as ["--option"], or WINEDLLOVERRIDES="xinput1_4=n,b" %command%. DLL overrides can also be entered below.'); }
    if (!Array.isArray(argv) || argv.some(item => typeof item !== 'string')) throw Error('Launch arguments must be an array of strings.');
    return { argv, dllOverrides: validateDllOverrides(overrides) };
}
module.exports = { parseProtonLaunchOptions };
