'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const policyPath = path.join(root, 'runtime', 'fitGirlInstaller.ps1');
const policy = fs.readFileSync(policyPath, 'utf8');

test('FitGirl installer policy parses in Windows PowerShell', () => {
    const command = [
        '$tokens = $null',
        '$errors = $null',
        '[void][System.Management.Automation.Language.Parser]::ParseFile($env:SAIL_POLICY_PATH, [ref]$tokens, [ref]$errors)',
        'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }'
    ].join('; ');
    const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
        env: { ...process.env, SAIL_POLICY_PATH: policyPath },
        windowsHide: true
    });
    assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
});

test('FitGirl installer native window and audio helpers compile', () => {
    const source = policy.match(/Add-Type -TypeDefinition @"\r?\n([\s\S]*?)\r?\n"@/);
    assert.ok(source, 'embedded C# source was not found');
    const compiled = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '[void](Add-Type -TypeDefinition $env:SAIL_NATIVE_SOURCE -PassThru)'
    ], {
        encoding: 'utf8',
        env: { ...process.env, SAIL_NATIVE_SOURCE: source[1] },
        windowsHide: true
    });
    assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
});

test('skip prerequisites stays wired from the instant setting to the elevated policy', () => {
    assert.match(index, /wireInstantToggle\('dlSkipRedistToggle', 'dlSkipRedist'\)/);
    assert.match(index, /skipRedist:\s*globalSettings\.dlSkipRedist !== false/);
    assert.match(main, /SAIL_SKIP_REDIST:\s*skipExtras \? '1' : '0'/);
    assert.match(main, /SAIL_ELEVATED:\s*'0'/);
    assert.match(main, /fitGirlInstaller\.ps1/);
    assert.match(policy, /param\(\[string\]\$ConfigBase64 = ''\)/);
    assert.match(policy, /FromBase64String\(\$ConfigBase64\)/);
    assert.match(policy, /'-ConfigBase64', \$encodedConfig/);
    assert.match(main, /\/NOICONS \/TASKS=""/);
    assert.doesNotMatch(main, /\/COMPONENTS=""/);
    assert.match(main, /if \(code !== 0\) return reject\(new Error\('FitGirl installer failed with exit code '/);
});

test('the elevated watcher acts only on the launched installer descendant graph', () => {
    assert.match(policy, /Get-CimInstance Win32_Process/);
    assert.match(policy, /ParentProcessId/);
    assert.match(policy, /CreationDate/);
    assert.match(policy, /\$script:owned\.ContainsKey\(\$parent\)/);
    assert.match(policy, /\$script:owned\.ContainsKey\(\$pidValue\)/);
    assert.match(policy, /Stop-Process -Id \$pidValue -Force/);
    assert.doesNotMatch(policy, /Stop-Process\s+-Name|taskkill(?:\.exe)?\s+\/IM/i);
    assert.match(policy, /dxsetup\|dxwebsetup\|vc_redist[\s\S]{0,180}Test-OwnedPayloadPath \$row/);
});

test('skip policy closes only clean finished integrity checks and blocks exact extras', () => {
    assert.match(policy, /\$finished = \$windowText -match '[^']*Finished/);
    assert.match(policy, /\$clean = \$windowText -match '[^']*All files OK'[\s\S]{0,180}Bad:[^\n]+Missing:/);
    assert.match(policy, /if \(\$finished -and \$clean\)[\s\S]{0,120}completed-integrity-check/);
    assert.match(policy, /elseif \(\$finished\)[\s\S]{0,120}INTEGRITY_REQUIRES_ATTENTION/);
    assert.match(policy, /Applying redirection rules for fake FitGirl sites/);
    assert.match(policy, /fg-optional-fake-site-redirect/);
    assert.match(policy, /Stop-OwnedProcess \$row 'prerequisite'/);
});

test('hosts cleanup preserves existing and unrelated entries', () => {
    assert.match(policy, /-not \$script:hostsBefore\.ContainsKey\(\$line\)/);
    assert.match(policy, /\$newFitGirlRule[\s\S]{0,180}\$line -match '[^']*fitgirl/);
    assert.match(policy, /else \{\s*\[void\]\$kept\.Add\(\$line\)/);
    assert.match(policy, /finally \{\s*Restore-NewFitGirlHostsEntries/);
    assert.doesNotMatch(policy, /Set-Content[^\n]+hosts|WriteAllText\([^\n]+hostsSnapshot\.Text/i);
});

test('the real policy closes only owned prerequisite, redirect, and clean integrity descendants', { timeout: 60000 }, () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sail-fitgirl-policy-'));
    try {
        const sourcePath = path.join(__dirname, 'fixtures', 'fitgirl-policy-harness.cs');
        const installerPath = path.join(tempRoot, 'FakeSetup.exe');
        const compile = spawnSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            'Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:SAIL_HARNESS_SOURCE)) -ReferencedAssemblies System.Windows.Forms.dll,System.Drawing.dll -OutputAssembly $env:SAIL_HARNESS_EXE -OutputType WindowsApplication'
        ], {
            encoding: 'utf8',
            env: {
                ...process.env,
                SAIL_HARNESS_SOURCE: sourcePath,
                SAIL_HARNESS_EXE: installerPath
            },
            windowsHide: true,
            timeout: 30000
        });
        assert.equal(compile.status, 0, compile.stderr || compile.stdout);
        fs.copyFileSync(installerPath, path.join(tempRoot, 'dxsetup.exe'));
        fs.copyFileSync(installerPath, path.join(tempRoot, 'QuickSFV.exe'));
        fs.copyFileSync(installerPath, path.join(tempRoot, 'cmd.exe'));

        const target = path.join(tempRoot, 'target');
        const statusPath = path.join(tempRoot, 'status.log');
        const mutePath = path.join(tempRoot, 'mute.flag');
        fs.mkdirSync(target);
        fs.writeFileSync(mutePath, '0', 'utf8');
        const innoLog = path.join(tempRoot, 'inno.log');
        const elevatedConfig = Buffer.from(JSON.stringify({
            installer: installerPath,
            target,
            innoArgs: '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOICONS /TASKS=""',
            skipExtras: true,
            statusFile: statusPath,
            muteFlag: mutePath,
            innoLog
        }), 'utf8').toString('base64');
        const relaunchCommand = [
            '$quotedScript = \'"\' + $env:SAIL_POLICY_PATH + \'"\'',
            '$child = Start-Process -FilePath \"powershell.exe\" -ArgumentList @(' +
                '\"-NoProfile\", \"-NonInteractive\", \"-ExecutionPolicy\", \"Bypass\", ' +
                '\"-File\", $quotedScript, \"-ConfigBase64\", $env:SAIL_CONFIG_BASE64) ' +
                '-WindowStyle Hidden -Wait -PassThru',
            'exit ([int]$child.ExitCode)'
        ].join('; ');
        const run = spawnSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command', relaunchCommand
        ], {
            encoding: 'utf8',
            env: {
                ...process.env,
                SAIL_POLICY_PATH: policyPath,
                SAIL_CONFIG_BASE64: elevatedConfig
            },
            windowsHide: true,
            timeout: 45000
        });
        assert.equal(run.status, 0, run.stderr || run.stdout);
        const status = fs.readFileSync(statusPath, 'utf8');
        assert.match(status, /SKIP prerequisite[^\n]+name=dxsetup\.exe/i);
        assert.match(status, /SKIP fake-site-redirect[^\n]+name=cmd\.exe/i);
        assert.match(status, /SKIP completed-integrity-check[^\n]+name=QuickSFV\.exe/i);
        assert.match(status, /DONE[^\n]+exit=0/);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
