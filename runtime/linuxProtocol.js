'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { desktopString, launcherCommand, readDesktopFile, updateDesktopEntry, writeDesktopFile } = require('./linuxDesktopEntry');

const DESKTOP_ID = 'com.aseoriy.saillauncher.desktop';
const SCHEME = 'sail-launcher';
const MARKER = 'protocol-v1';

class LinuxProtocol {
    constructor({ app, home = os.homedir(), env = process.env, executablePath = process.execPath }) {
        this.app = app;
        this.executablePath = executablePath;
        const dataHome = typeof env.XDG_DATA_HOME === 'string' && path.isAbsolute(env.XDG_DATA_HOME)
            && !/[\u0000-\u001f\u007f]/.test(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
        this.filePath = path.join(dataHome, 'applications', DESKTOP_ID);
        this.queue = Promise.resolve();
    }

    async command() {
        if (!this.app.isPackaged || !path.isAbsolute(this.executablePath)) {
            throw new Error('Use a packaged Linux build to register Sail links.');
        }
        const executable = await fs.promises.realpath(this.executablePath);
        if (!(await fs.promises.stat(executable)).isFile()) throw new Error('The installed launcher is unavailable.');
        await fs.promises.access(executable, fs.constants.X_OK);
        // This field code is intentionally separate; literal path percent signs
        // have already been encoded by the shared Exec encoder.
        return { executable, exec: `${launcherCommand({ executablePath: executable }, [])} %u` };
    }

    async status() {
        const { executable, exec } = await this.command();
        const entry = await readDesktopFile(this.filePath);
        const configured = !!entry && entry.values['X-Sail-Managed'] === MARKER
            && entry.values.Type === 'Application' && entry.values.Exec === exec
            && entry.values.TryExec === desktopString(executable)
            && entry.values.Hidden !== 'true' && entry.values.DBusActivatable !== 'true'
            && !entry.values.OnlyShowIn && !entry.values.NotShowIn
            && entry.values.MimeType?.split(';').includes(`x-scheme-handler/${SCHEME}`);
        return { configured: !!configured, registered: !!configured && this.app.isDefaultProtocolClient(SCHEME) };
    }

    register() {
        const operation = this.queue.then(() => this.apply());
        this.queue = operation.catch(() => {});
        return operation;
    }

    async apply() {
        const { executable, exec } = await this.command();
        const previous = await readDesktopFile(this.filePath);
        if (previous && (previous.stat.uid !== process.getuid() || previous.values['X-Sail-Managed'] !== MARKER)) {
            throw new Error('An existing Sail application entry is managed outside Sail. Change its link association in your desktop settings.');
        }
        if (previous && (previous.values.OnlyShowIn || previous.values.NotShowIn)) {
            throw new Error('The Sail application entry has desktop restrictions. Adjust them in your desktop settings first.');
        }
        const mimeTypes = new Set((previous?.values.MimeType || '').split(';').filter(Boolean));
        mimeTypes.add(`x-scheme-handler/${SCHEME}`);
        const content = updateDesktopEntry(previous?.text || '[Desktop Entry]\n', {
            Type: 'Application', Name: 'Sail Launcher', Exec: exec, TryExec: desktopString(executable),
            Icon: 'applications-games', Terminal: 'false', Categories: 'Game;', Hidden: 'false',
            DBusActivatable: 'false', MimeType: `${Array.from(mimeTypes).join(';')};`,
            'X-Sail-Managed': MARKER
        });
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        await writeDesktopFile(this.filePath, content, { previous });
        const accepted = this.app.setAsDefaultProtocolClient(SCHEME);
        const status = await this.status();
        if (!accepted || !status.registered) {
            throw new Error('Sail created its application entry, but the desktop did not confirm the link association. Choose Sail in your desktop default-application settings.');
        }
        return status;
    }
}

function registerLinuxProtocolIpc({ ipcMain, app }) {
    let provider;
    const getProvider = () => provider || (provider = new LinuxProtocol({ app }));
    ipcMain.handle('desktop-protocol-status', () => getProvider().status());
    ipcMain.handle('desktop-register-protocol', () => getProvider().register());
}

module.exports = { LinuxProtocol, registerLinuxProtocolIpc, DESKTOP_ID };
