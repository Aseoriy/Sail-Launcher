'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { desktopString, launcherCommand, writeDesktopFile } = require('./linuxDesktopEntry');

function desktopName(value) {
    const name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
    return desktopString(name || 'Game');
}

async function createLinuxGameShortcut({ desktopPath, executablePath, sourcePath, gameId, gameName }) {
    if (!path.isAbsolute(desktopPath) || !path.isAbsolute(executablePath) || executablePath.includes('=')
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(gameId)) {
        throw new Error('The desktop shortcut destination or game identity is invalid.');
    }
    const desktop = await fs.promises.realpath(desktopPath);
    if (!(await fs.promises.stat(desktop)).isDirectory()) throw new Error('The desktop folder is unavailable.');
    const launch = launcherCommand({ executablePath, sourcePath }, [`--launch-game-id=${gameId}`]);
    const digest = crypto.createHash('sha256').update(gameId).digest('hex').slice(0, 24);
    const shortcutPath = path.join(desktop, `com.aseoriy.saillauncher.game-${digest}.desktop`);
    const content = `[Desktop Entry]\nType=Application\nName=${desktopName(gameName)}\nExec=${launch}\nIcon=applications-games\nTerminal=false\nCategories=Game;\n`;
    try {
        await writeDesktopFile(shortcutPath, content, { mode: 0o755 });
    } catch (error) {
        if (error.code === 'EEXIST') throw new Error('A shortcut for this game already exists on the desktop.');
        throw error;
    }
    return true;
}

module.exports = { createLinuxGameShortcut };
