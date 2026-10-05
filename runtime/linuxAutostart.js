'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { desktopString, launcherCommand, readDesktopFile, updateDesktopEntry, writeDesktopFile } = require('./linuxDesktopEntry');

const ENTRY_NAME = 'com.aseoriy.saillauncher.desktop';
const MANAGED_KEY = 'X-Sail-Managed';
const MANAGED_VALUE = 'autostart-v1';

function absoluteDirectory(value, fallback) {
    return typeof value === 'string' && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value) ? value : fallback;
}

class LinuxAutostart {
    constructor({ home = os.homedir(), env = process.env, executablePath = process.execPath, sourcePath = null } = {}) {
        if (!path.isAbsolute(home)) throw new Error('The home directory must be absolute.');
        this.command = { executablePath, sourcePath };
        this.directory = path.join(absoluteDirectory(env.XDG_CONFIG_HOME, path.join(home, '.config')), 'autostart');
        this.filePath = path.join(this.directory, ENTRY_NAME);
        const roots = (env.XDG_CONFIG_DIRS || '/etc/xdg').split(':').filter(value => absoluteDirectory(value, null)).slice(0, 32);
        this.systemPaths = roots.map(root => path.join(root, 'autostart', ENTRY_NAME));
        this.desktops = (env.XDG_CURRENT_DESKTOP || '').split(':').filter(Boolean);
        this.searchPath = (env.PATH || '/usr/bin:/bin').split(':').filter(directory => path.isAbsolute(directory));
        this.queue = Promise.resolve();
    }

    async effectiveEntry() {
        const user = await readDesktopFile(this.filePath);
        if (user) return { entry: user, user };
        for (const filePath of this.systemPaths) {
            const entry = await readDesktopFile(filePath);
            if (entry) return { entry, user: null };
        }
        return { entry: null, user: null };
    }

    async get() {
        const { entry } = await this.effectiveEntry();
        if (!entry) return false;
        const value = entry.values;
        if (value.Type !== 'Application' || !value.Exec || value.Hidden === 'true' || value['X-GNOME-Autostart-enabled'] === 'false') return false;
        const list = key => (value[key] || '').split(';').filter(Boolean);
        if (value.OnlyShowIn && !list('OnlyShowIn').some(name => this.desktops.includes(name))) return false;
        if (value.NotShowIn && list('NotShowIn').some(name => this.desktops.includes(name))) return false;
        if (value.TryExec) {
            const executable = value.TryExec.replace(/\\([sntr\\])/g, (_match, character) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' })[character]);
            const candidates = path.isAbsolute(executable) ? [executable]
                : executable.includes('/') ? [] : this.searchPath.map(directory => path.join(directory, executable));
            let found = false;
            for (const candidate of candidates) {
                try {
                    if (!(await fs.promises.stat(candidate)).isFile()) continue;
                    await fs.promises.access(candidate, fs.constants.X_OK);
                    found = true;
                    break;
                } catch (_) { /* Try the next PATH directory. */ }
            }
            if (!found) return false;
        }
        return true;
    }

    set(enabled) {
        if (typeof enabled !== 'boolean') return Promise.reject(new Error('The autostart setting must be a boolean.'));
        const operation = this.queue.then(() => this.apply(enabled));
        this.queue = operation.catch(() => {});
        return operation;
    }

    async apply(enabled) {
        const { entry, user } = await this.effectiveEntry();
        if (user && (user.stat.uid !== process.getuid() || user.values[MANAGED_KEY] !== MANAGED_VALUE)) {
            throw new Error('An existing Sail startup entry is managed outside Sail. Change it in your desktop startup settings.');
        }
        if (!enabled && !entry) return false;
        if (enabled && entry && (entry.values.OnlyShowIn || entry.values.NotShowIn)) {
            throw new Error('The startup entry has desktop restrictions. Adjust them in your desktop startup settings first.');
        }
        let content = entry ? entry.text : '[Desktop Entry]\n';
        const updates = { [MANAGED_KEY]: MANAGED_VALUE, Hidden: enabled ? 'false' : 'true' };
        if (enabled) Object.assign(updates, { Type: 'Application', Name: 'Sail Launcher',
            Exec: launcherCommand(this.command, ['--hidden']), TryExec: desktopString(this.command.executablePath),
            Icon: 'applications-games', Terminal: 'false', 'X-GNOME-Autostart-enabled': 'true' });
        content = updateDesktopEntry(content, updates);
        await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeDesktopFile(this.filePath, content, { previous: user });
        return this.get();
    }
}

function registerAutostartIpc({ ipcMain, app, platform = process.platform, createProvider }) {
    let provider;
    function linuxProvider() {
        if (!provider) provider = createProvider ? createProvider() : new LinuxAutostart({
            sourcePath: process.defaultApp ? path.resolve(process.argv[1]) : null
        });
        return provider;
    }
    ipcMain.handle('get-autostart', () => platform === 'linux' ? linuxProvider().get() : app.getLoginItemSettings().openAtLogin);
    ipcMain.handle('set-autostart', (_event, enabled) => {
        if (typeof enabled !== 'boolean') throw new Error('The autostart setting must be a boolean.');
        if (platform === 'linux') return linuxProvider().set(enabled);
        app.setLoginItemSettings({ openAtLogin: enabled, path: app.getPath('exe'), args: ['--hidden'] });
        return enabled;
    });
}

module.exports = { LinuxAutostart, registerAutostartIpc, ENTRY_NAME };
