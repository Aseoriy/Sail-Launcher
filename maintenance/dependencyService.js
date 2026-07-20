'use strict';

const fs = require('fs');
const path = require('path');

function exists(candidate) {
    try { return !!candidate && fs.existsSync(candidate); } catch (_) { return false; }
}

class DependencyService {
    constructor(options = {}) {
        this.providers = [];
        this.env = options.env || process.env;
        this.platform = options.platform || process.platform;
        this.registerDefaults();
    }

    register(provider) {
        if (!provider || !provider.id || typeof provider.check !== 'function') throw new Error('Invalid dependency provider.');
        this.providers.push(provider);
    }

    registerDefaults() {
        this.register({ id: 'vcredist', name: 'Microsoft Visual C++ Runtime', officialUrl: 'https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist', check: () => {
            if (this.platform !== 'win32') return { status: 'not-applicable' };
            const systemRoot = this.env.SystemRoot || 'C:\\Windows';
            return { status: exists(path.join(systemRoot, 'System32', 'vcruntime140.dll')) ? 'detected' : 'uncertain' };
        }});
        this.register({ id: 'directx-legacy', name: 'DirectX legacy runtime components', officialUrl: 'https://www.microsoft.com/download/details.aspx?id=35', check: () => {
            if (this.platform !== 'win32') return { status: 'not-applicable' };
            const systemRoot = this.env.SystemRoot || 'C:\\Windows';
            const found = exists(path.join(systemRoot, 'System32', 'd3dx9_43.dll')) || exists(path.join(systemRoot, 'SysWOW64', 'd3dx9_43.dll'));
            return { status: found ? 'detected' : 'uncertain' };
        }});
        this.register({ id: 'dotnet-desktop', name: '.NET Desktop Runtime', officialUrl: 'https://dotnet.microsoft.com/download/dotnet', check: () => {
            if (this.platform !== 'win32') return { status: 'not-applicable' };
            const root = this.env.ProgramFiles || 'C:\\Program Files';
            return { status: exists(path.join(root, 'dotnet', 'shared', 'Microsoft.WindowsDesktop.App')) ? 'detected' : 'uncertain' };
        }});
        this.register({ id: 'java', name: 'Java runtime', officialUrl: 'https://adoptium.net/', check: () => ({ status: exists(this.env.JAVA_HOME) ? 'detected' : 'uncertain' }) });
        this.register({ id: 'emulator-firmware', name: 'Emulator BIOS or firmware', officialUrl: '', check: game => {
            if (!game.isRom) return { status: 'not-applicable' };
            if (!game.firmwarePath) return { status: 'uncertain', details: 'This emulator game has no firmware path configured.' };
            return { status: exists(game.firmwarePath) ? 'detected' : 'missing' };
        }});
        this.register({ id: 'companion', name: 'Configured companion application', officialUrl: '', check: game => {
            if (!game.companionApp) return { status: 'not-applicable' };
            return { status: exists(game.companionApp) ? 'detected' : 'missing', path: game.companionApp };
        }});
    }

    async check(game, context = {}) {
        const requested = new Set(Array.isArray(game.dependencyRequirements) ? game.dependencyRequirements : []);
        const output = [];
        for (const provider of this.providers) {
            let result;
            try { result = await provider.check(game, context); }
            catch (error) { result = { status: 'uncertain', details: error.message }; }
            if (requested.has(provider.id) && result.status === 'uncertain') result.status = 'missing';
            output.push(Object.assign({ id: provider.id, name: provider.name, officialUrl: provider.officialUrl || '' }, result));
        }
        return output;
    }
}

module.exports = { DependencyService };
