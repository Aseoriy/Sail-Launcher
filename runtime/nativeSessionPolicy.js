'use strict';

const fs = require('node:fs');
const path = require('node:path');

const installed = new WeakMap();
// Linux has no system spellchecker Chromium can use, and Chromium would download its dictionaries from Google.
// Sail ships the English ones (runtime/dictionaries) and points downloads at a port that refuses connections.
const BUNDLED_DICTIONARIES = ['en-US', 'en-GB', 'en-CA', 'en-AU'];
const DICTIONARY_VERSION = '10-1';
const NO_DICTIONARY_DOWNLOADS = 'http://127.0.0.1:9/';

function disableSpellcheck({ isolated = process.env.SAIL_DEV_ISOLATED === '1' } = {}) {
    return isolated;
}

// The bundled dictionary for the first preferred language Sail has one for; other English variants use en-US.
function bundledSpellcheckLanguage(preferred = []) {
    for (const tag of preferred) {
        const text = String(tag || '').replace(/_/g, '-');
        const exact = BUNDLED_DICTIONARIES.find(language => language.toLowerCase() === text.toLowerCase());
        if (exact) return exact;
        if (/^en(?:-|$)/i.test(text)) return 'en-US';
    }
    return '';
}

// Chromium loads <userData>/Dictionaries/<language>-<version>.bdic when it exists instead of downloading it.
function installBundledDictionaries(userData, source = path.join(__dirname, 'dictionaries')) {
    const target = path.join(userData, 'Dictionaries');
    fs.mkdirSync(target, { recursive: true });
    for (const language of BUNDLED_DICTIONARIES) {
        const name = `${language}-${DICTIONARY_VERSION}.bdic`;
        const bytes = fs.readFileSync(path.join(source, name));
        let current = null;
        try { current = fs.readFileSync(path.join(target, name)); } catch (_) { /* Not copied yet. */ }
        if (!current || !current.equals(bytes)) fs.writeFileSync(path.join(target, name), bytes);
    }
}

function installNativeSessionPolicy({ app }, options = {}) {
    const isolated = options.isolated ?? process.env.SAIL_DEV_ISOLATED === '1';
    const platform = options.platform || process.platform;
    let policy = installed.get(app);
    if (policy) {
        policy.isolated ||= isolated;
        policy.spellcheckDisabled ||= disableSpellcheck(options);
        return;
    }
    policy = { isolated, platform, spellcheckDisabled: disableSpellcheck(options), language: null };
    installed.set(app, policy);
    // Install before any sessions are created. Hunspell bypasses webRequest;
    // clearing its dictionary list must precede disabling optional spellcheck.
    app.on('session-created', session => {
        if (policy.spellcheckDisabled) {
            session.setSpellCheckerLanguages([]);
            session.setSpellCheckerEnabled(false);
            return;
        }
        if (policy.platform !== 'linux') return;
        if (policy.language === null) {
            try {
                installBundledDictionaries(app.getPath('userData'));
                policy.language = bundledSpellcheckLanguage(typeof app.getPreferredSystemLanguages === 'function'
                    ? app.getPreferredSystemLanguages() : [app.getLocale()]);
            } catch (error) {
                console.error('Spell-check dictionaries could not be installed:', error.message);
                policy.language = '';
            }
        }
        session.setSpellCheckerDictionaryDownloadURL(NO_DICTIONARY_DOWNLOADS);
        session.setSpellCheckerLanguages(policy.language ? [policy.language] : []);
        if (!policy.language) session.setSpellCheckerEnabled(false);
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

module.exports = { disableSpellcheck, installNativeSessionPolicy, bundledSpellcheckLanguage, installBundledDictionaries, NO_DICTIONARY_DOWNLOADS };
