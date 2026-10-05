'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PYTHON_PROGRAM = 'import sys,json,ssl,lzma,zlib,tarfile,tomllib,zipfile; print(json.dumps({"version":list(sys.version_info[:3])}))';
const MIN_INSTALL_SPACE = 256 * 1024 ** 2;
const SUGGESTED_SPACE = 8 * 1024 ** 3;
const check = (id, label, state, detail, blocking = false) => ({ id, label, state, detail, blocking });

function text(file, limit = 16384) {
    const fd = fs.openSync(file, 'r');
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > limit) throw Error('System metadata is unavailable.');
        const bytes = Buffer.alloc(limit + 1), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (count > limit) throw Error('System metadata is too large.');
        return bytes.subarray(0, count).toString('utf8');
    } finally { fs.closeSync(fd); }
}
function distribution() {
    try {
        const value = text('/etc/os-release');
        const id = value.match(/^ID=(?:"([a-z0-9_-]+)"|([a-z0-9_-]+))$/m);
        return id?.[1] || id?.[2] || '';
    } catch (_) { return ''; }
}
function libraryPresent(files, bits) {
    for (const file of files) {
        let fd;
        try {
            fd = fs.openSync(file, 'r');
            const stat = fs.fstatSync(fd), header = Buffer.alloc(20);
            if (stat.isFile() && fs.readSync(fd, header, 0, header.length, 0) === header.length
                && header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
                && header[4] === (bits === 64 ? 2 : 1) && header[5] === 1
                && header.readUInt16LE(16) === 3 && header.readUInt16LE(18) === (bits === 64 ? 62 : 3)) return true;
        } catch (_) { /* A missing loader is a diagnostic, not a scan failure. */ }
        finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    return false;
}
function driverManifestPresent() {
    for (const directory of ['/etc/vulkan/icd.d', '/usr/share/vulkan/icd.d']) {
        let dir;
        try {
            dir = fs.opendirSync(directory);
            let entry, count = 0;
            while ((entry = dir.readSync()) && ++count <= 128) {
                if (!entry.name.endsWith('.json') || !entry.isFile()) continue;
                try {
                    const value = JSON.parse(text(path.join(directory, entry.name)));
                    if (typeof value.ICD?.library_path === 'string' && value.ICD.library_path) return true;
                } catch (_) {}
            }
        } catch (_) {}
        finally { try { dir?.closeSync(); } catch (_) {} }
    }
    return false;
}
function nearestDirectory(root) {
    let current = path.resolve(root);
    while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) throw Error('Compatibility storage is unavailable.');
        current = parent;
    }
    if (!fs.statSync(current).isDirectory()) throw Error('Compatibility storage is not a folder.');
    return current;
}

class HostRequirements {
    constructor({ root, enabled }) {
        this.root = root; this.enabled = enabled; this.cached = null; this.pending = null; this.child = null;
    }
    python() {
        return new Promise(resolve => {
            const missing = detail => check('python', 'Python 3', 'missing', detail, true);
            let child, timer, output = '', settled = false;
            const finish = result => {
                if (settled) return;
                settled = true; clearTimeout(timer);
                if (this.child === child) this.child = null;
                resolve(result);
            };
            try {
                // Fixed system executable and fixed app source. Do not execute
                // tools found in PATH or downloaded programs to check the host.
                child = spawn('/usr/bin/python3', ['-I', '-c', PYTHON_PROGRAM], {
                    stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }
                });
                this.child = child;
                timer = setTimeout(() => { child.kill('SIGKILL'); finish(missing('Python could not be checked. Check Python 3 in your system package manager, then retry.')); }, 4000);
                child.stdout.on('data', bytes => {
                    output += bytes.toString();
                    if (output.length > 2048) { child.kill('SIGKILL'); finish(missing('Python returned an unexpected result. Check your system Python installation.')); }
                });
                child.on('error', () => finish(missing('Install Python 3.11 or newer with your system package manager, then recheck setup.')));
                child.on('close', code => {
                    try {
                        const result = JSON.parse(output);
                        if (code !== 0 || !Array.isArray(result.version) || result.version.length !== 3
                            || !result.version.every(Number.isSafeInteger) || result.version[0] !== 3 || result.version[1] < 11) throw Error('Unsupported Python.');
                        finish(check('python', 'Python 3', 'detected', `Python ${result.version.join('.')} and the required standard libraries are available.`));
                    } catch (_) { finish(missing('Python 3.11 or newer with SSL, TOML and archive support is required. Repair or update your system Python, then recheck setup.')); }
                });
            } catch (_) { finish(missing('Python 3 is unavailable. Install it with your system package manager, then recheck setup.')); }
        });
    }
    async inspect(force = false) {
        if (!this.enabled) return { available: false, canInstall: false, checkedAt: Date.now(), checks: [], reason: 'Windows gaming setup is unavailable in this platform mode.' };
        if (this.pending) return this.pending;
        if (!force && this.cached && Date.now() - this.cached.checkedAt < 30000) return this.cached;
        this.pending = this.collect();
        try { this.cached = await this.pending; return this.cached; }
        finally { this.pending = null; }
    }
    async collect() {
        const python = await this.python(), checks = [python];
        if (process.platform !== 'linux' || process.arch !== 'x64') checks.push(check('platform', 'Linux x64', 'missing', 'Managed Windows gaming setup currently supports Linux x64.', true));
        let freeBytes = null;
        try {
            const directory = nearestDirectory(this.root);
            fs.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK);
            const stat = fs.statfsSync(directory); freeBytes = stat.bavail * stat.bsize;
            checks.push(check('storage', 'Compatibility storage', freeBytes < MIN_INSTALL_SPACE ? 'missing' : freeBytes < SUGGESTED_SPACE ? 'warning' : 'detected',
                `${(freeBytes / 1024 ** 3).toFixed(1)} GB free. Allow about 8 GB for downloading and extracting Proton; games need additional space.`, freeBytes < MIN_INSTALL_SPACE));
        } catch (_) { checks.push(check('storage', 'Compatibility storage', 'missing', 'Sail cannot use its compatibility storage folder. Check the folder permissions and free space, then retry.', true)); }
        const vulkan64 = libraryPresent(['/usr/lib/x86_64-linux-gnu/libvulkan.so.1', '/lib/x86_64-linux-gnu/libvulkan.so.1', '/usr/lib64/libvulkan.so.1', '/usr/lib/libvulkan.so.1'], 64);
        const vulkan32 = libraryPresent(['/usr/lib/i386-linux-gnu/libvulkan.so.1', '/lib/i386-linux-gnu/libvulkan.so.1', '/usr/lib32/libvulkan.so.1', '/usr/lib/libvulkan.so.1'], 32);
        checks.push(check('vulkan64', '64-bit Vulkan', vulkan64 ? 'detected' : 'warning', vulkan64
            ? 'Vulkan loader found. A game launch still needs to confirm driver support.' : 'A Vulkan loader was not found in common system locations. Check your distribution’s graphics packages.'));
        checks.push(check('vulkan32', '32-bit Vulkan', vulkan32 ? 'detected' : 'warning', vulkan32
            ? '32-bit Vulkan loader found. Matching 32-bit graphics drivers may also be needed.' : 'A 32-bit Vulkan loader was not found in common locations. Some Windows games need your distribution’s 32-bit graphics packages.'));
        const driver = driverManifestPresent();
        checks.push(check('graphics', 'Graphics driver', driver ? 'detected' : 'warning', driver
            ? 'Vulkan driver metadata found. Rendering has not been checked.' : 'Vulkan driver metadata was not found in common locations. Install the appropriate graphics driver using your distribution’s tools.'));
        let disabled = false;
        for (const file of ['/proc/sys/user/max_user_namespaces', '/proc/sys/kernel/unprivileged_userns_clone']) {
            try { if (text(file).trim() === '0') disabled = true; } catch (_) {}
        }
        checks.push(check('containers', 'Linux runtime containers', disabled ? 'warning' : 'unchecked', disabled
            ? 'System settings appear to disable user namespaces. UMU may be unable to start; consult your distribution’s guidance.'
            : 'Container support is confirmed during launch. Security policies can affect UMU even when user namespaces are enabled.'));
        return { available: true, canInstall: !checks.some(item => item.blocking), checkedAt: Date.now(), freeBytes, distribution: distribution(), checks,
            reason: checks.find(item => item.blocking)?.detail || '' };
    }
    async assertInstallable(backend = 'proton-umu', { archive = false } = {}) {
        const result = await this.inspect(true);
        if (backend === 'wine' && result.available) {
            const blocking = result.checks.find(item => item.blocking && (item.id !== 'python' || archive));
            if (blocking) throw Error(blocking.detail);
            return result;
        }
        if (!result.canInstall) throw Error(result.reason || 'Check Windows gaming setup before installing compatibility tools.');
        return result;
    }
    dispose() { this.child?.kill('SIGKILL'); }
}

function setupStatus({ system, runtimes, defaultRuntimeId, discovery, readiness, noticeDismissed, wineLaunch }) {
    const selected = runtimes.find(item => item.id === defaultRuntimeId && item.ready);
    const wine = selected?.backend === 'wine';
    const launcher = !!readiness?.available && !!readiness.scriptsAvailable && !!(wine ? readiness.wineTrackingAvailable : readiness.windowsTrackingAvailable);
    const umu = !!discovery?.umu?.length || runtimes.some(item => item.ready && item.backend !== 'wine');
    const proton = runtimes.some(item => item.ready && item.backend !== 'wine');
    const checks = [
        check('launcher', 'Sail game launching', launcher ? 'detected' : 'missing', launcher
            ? 'The installed launcher supports Windows process tracking.' : readiness?.reason || 'Update Sail to a build with Windows process tracking.', !launcher),
        ...system.checks.map(item => wine && item.id === 'python' ? { ...item, blocking: false,
            detail: 'Python is needed for managed Proton downloads and archive extraction; standalone Wine does not require it for launching.' } : item),
        check('umu', 'UMU launcher', umu ? 'detected' : 'missing', umu ? 'An installed UMU launcher was found.' : 'Setup downloads UMU from its official release.'),
        check('proton', 'Proton', proton ? 'detected' : 'missing', proton ? 'An approved Proton version is available.' : 'Setup installs GE-Proton. You can also use an installed version below.'),
        ...(wine ? [check('wine', 'Standalone Wine', wineLaunch?.available ? 'detected' : 'missing', wineLaunch?.reason || selected.label, !wineLaunch?.available)] : []),
        check('default', 'Default for new games', selected ? 'detected' : 'missing', selected ? selected.label
            : defaultRuntimeId ? 'The previous default is unavailable. Choose an installed version below.' : 'Setup chooses an available version for new Windows games.'),
        check('environment', 'Game initialization', 'unchecked', wine
            ? 'Wine uses a separate environment for each game. Host Wine libraries and graphics support must already be installed.'
            : 'First Play initializes the game’s Windows environment and acquires any missing Linux runtime. This can require internet and take a few minutes.')
    ];
    const blocking = checks.find(item => item.blocking), toolsReady = !!selected && !blocking && system.available;
    const defaultUnavailable = !!defaultRuntimeId && !selected;
    return { phase: blocking ? 'needs-attention' : toolsReady ? 'tools-ready' : 'tools-required', toolsReady,
        canInstall: system.canInstall && launcher, canSetUp: system.canInstall && launcher && !defaultUnavailable, noticeDismissed, checkedAt: system.checkedAt, checks,
        summary: blocking ? blocking.detail : defaultUnavailable ? 'Your previous default is unavailable. Choose another version below to finish setup.'
            : toolsReady ? 'Compatibility tools are ready. Each game initializes its environment on first Play.'
            : 'Set up compatibility tools for Windows games. Steam is not required.' };
}

module.exports = { HostRequirements, setupStatus };
