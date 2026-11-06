'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// A stick has to be pushed this far (of 32767) to count, so a drifting stick at rest isn't "activity".
const STICK_THRESHOLD = 12000;
const JS_EVENT_BUTTON = 0x01, JS_EVENT_AXIS = 0x02, JS_EVENT_INIT = 0x80;

// Linux: the kernel joystick devices (/dev/input/js*) are readable by the signed-in user on
// desktop distros. Each open gets its own event queue, so reading never takes input from the game.
class LinuxControllers {
    constructor({ inputDir = '/dev/input', now = Date.now } = {}) {
        this.inputDir = inputDir;
        this.now = now;
        this.devices = new Map();
        this.lastAt = 0;
    }

    open() {
        let names = [];
        try { names = fs.readdirSync(this.inputDir).filter(name => /^js\d+$/.test(name)); } catch (_) { return; }
        for (const name of names) {
            const file = path.join(this.inputDir, name);
            if (this.devices.has(file)) continue;
            try { this.devices.set(file, fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); }
            catch (_) { this.devices.set(file, null); /* Not readable here; keyboard/mouse idle still applies. */ }
        }
    }

    poll() {
        this.open();
        const buffer = Buffer.alloc(8 * 64);
        for (const [file, fd] of this.devices) {
            if (fd === null) continue;
            for (;;) {
                let count;
                try { count = fs.readSync(fd, buffer, 0, buffer.length, null); }
                catch (error) {
                    if (error.code !== 'EAGAIN') { try { fs.closeSync(fd); } catch (_) {} this.devices.delete(file); }
                    break;
                }
                if (!count) break;
                for (let offset = 0; offset + 8 <= count; offset += 8) {
                    const value = buffer.readInt16LE(offset + 4), type = buffer[offset + 6];
                    if (type & JS_EVENT_INIT) continue;
                    if (type & JS_EVENT_BUTTON && value !== 0 || type & JS_EVENT_AXIS && Math.abs(value) >= STICK_THRESHOLD) this.lastAt = this.now();
                }
                if (count < buffer.length) break;
            }
        }
    }

    close() {
        for (const fd of this.devices.values()) if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
        this.devices.clear();
    }
}

// Windows: system idle time (GetLastInputInfo) ignores controllers, so a small PowerShell loop asks
// XInput once a second and prints a line while any controller is being used.
const XINPUT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Sail -Name XInput -MemberDefinition '[DllImport("xinput1_4.dll")] public static extern int XInputGetState(int index, byte[] state);'
$state = New-Object byte[] 16
while ($true) {
    $used = $false
    for ($i = 0; $i -lt 4; $i++) {
        if ([Sail.XInput]::XInputGetState($i, $state) -ne 0) { continue }
        $sticks = @(8, 10, 12, 14) | ForEach-Object { [Math]::Abs([int][BitConverter]::ToInt16($state, $_)) }
        if ([BitConverter]::ToUInt16($state, 4) -ne 0 -or $state[6] -gt 30 -or $state[7] -gt 30 -or ($sticks | Where-Object { $_ -ge ${STICK_THRESHOLD} })) { $used = $true }
    }
    if ($used) { [Console]::Out.WriteLine('active'); [Console]::Out.Flush() }
    Start-Sleep -Milliseconds 1000
}`;

class WindowsControllers {
    constructor({ now = Date.now, spawnProcess = spawn } = {}) {
        this.now = now;
        this.spawnProcess = spawnProcess;
        this.child = null;
        this.failed = false;
        this.lastAt = 0;
    }

    open() {
        if (this.child || this.failed) return;
        const encoded = Buffer.from(XINPUT_SCRIPT, 'utf16le').toString('base64');
        const child = this.spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
            { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        this.child = child;
        child.stdout.on('data', () => { this.lastAt = this.now(); });
        child.on('error', () => { this.failed = true; this.child = null; });
        child.on('exit', code => { if (this.child === child) { this.child = null; if (code) this.failed = true; } });
    }

    poll() { this.open(); }

    close() {
        if (this.child) { try { this.child.kill(); } catch (_) {} this.child = null; }
    }
}

function createControllerActivity(platform = process.platform, options = {}) {
    const source = platform === 'linux' ? new LinuxControllers(options) : platform === 'win32' ? new WindowsControllers(options) : null;
    if (!source) return null;
    return {
        poll: () => source.poll(),
        lastActivityAt: () => source.lastAt,
        // Devices are only open (and PowerShell only runs) while a game is running.
        setActive: active => { if (!active) source.close(); }
    };
}

module.exports = { createControllerActivity, LinuxControllers, WindowsControllers, XINPUT_SCRIPT };
