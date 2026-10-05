'use strict';

const installed = new WeakMap();
function disableSpellcheck({ platform = process.platform, isolated = process.env.SAIL_DEV_ISOLATED === '1' } = {}) {
    return platform === 'linux' || isolated;
}

function installNativeSessionPolicy({ app }, options = {}) {
    const isolated = options.isolated ?? process.env.SAIL_DEV_ISOLATED === '1';
    let policy = installed.get(app);
    if (policy) {
        policy.isolated ||= isolated;
        policy.spellcheckDisabled ||= disableSpellcheck(options);
        return;
    }
    policy = { isolated, spellcheckDisabled: disableSpellcheck(options) };
    installed.set(app, policy);
    // Install before any sessions are created. Hunspell bypasses webRequest;
    // clearing its dictionary list must precede disabling optional spellcheck.
    app.on('session-created', session => {
        if (!policy.spellcheckDisabled) return;
        session.setSpellCheckerLanguages([]);
        session.setSpellCheckerEnabled(false);
    });
    app.on('select-client-certificate', (event, webContents, _url, _certificates, callback) => {
        // Electron 44 now offers platform certificates to native net requests
        // (webContents === null). Retain their previous lack of certificate
        // authority, and refuse every certificate selection in private modes.
        if (policy.isolated || webContents == null) {
            event.preventDefault();
            callback();
        }
    });
}

module.exports = { disableSpellcheck, installNativeSessionPolicy };
