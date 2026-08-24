'use strict';

const crypto = require('crypto');
const path = require('path');

const ARCHIVE_COMMANDS = Object.freeze({
    compress: [
        "$ErrorActionPreference = 'Stop'",
        "Import-Module (Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Archive\\Microsoft.PowerShell.Archive.psd1') -Force",
        "$source = [Environment]::GetEnvironmentVariable('SAIL_ARCHIVE_SOURCE')",
        "$destination = [Environment]::GetEnvironmentVariable('SAIL_ARCHIVE_DESTINATION')",
        '$sourceItem = Get-Item -LiteralPath $source -Force',
        '$entries = @($(if ($sourceItem.PSIsContainer) { Get-ChildItem -LiteralPath $source -Force } else { $sourceItem }))',
        "if ($entries.Count -eq 0) { throw 'The approved source is empty.' }",
        'Compress-Archive -LiteralPath $entries.FullName -DestinationPath $destination -Force'
    ].join('; '),
    expand: [
        "$ErrorActionPreference = 'Stop'",
        "Import-Module (Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Archive\\Microsoft.PowerShell.Archive.psd1') -Force",
        "$source = [Environment]::GetEnvironmentVariable('SAIL_ARCHIVE_SOURCE')",
        "$destination = [Environment]::GetEnvironmentVariable('SAIL_ARCHIVE_DESTINATION')",
        'Expand-Archive -LiteralPath $source -DestinationPath $destination -Force'
    ].join('; ')
});

function absoluteValue(value, label) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000\r\n]/.test(value)) {
        throw new TypeError(`${label} must be an absolute local path.`);
    }
    return path.normalize(value);
}

function createArchivePowerShellInvocation(action, sourcePath, destinationPath, baseEnvironment = process.env) {
    const command = ARCHIVE_COMMANDS[action];
    if (!command) throw new TypeError('Unsupported archive data binding action.');
    const source = absoluteValue(sourcePath, 'Archive source');
    const destination = absoluteValue(destinationPath, 'Archive destination');
    return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', command],
        options: {
            windowsHide: true,
            env: {
                ...baseEnvironment,
                SAIL_ARCHIVE_SOURCE: source,
                SAIL_ARCHIVE_DESTINATION: destination
            }
        }
    };
}

function scopedArtifactStem(scope = {}) {
    const components = ['profileId', 'libraryId', 'gameId'].map(key => {
        const value = String(scope[key] || '');
        if (!value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
            throw new TypeError(`Archive scope ${key} is invalid.`);
        }
        return value;
    });
    return `sail-${crypto.createHash('sha256').update(components.join('\u0000')).digest('hex').slice(0, 24)}`;
}

function legacyLocalArtifactStem(value) {
    if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) return null;
    const stem = value.replace(/[<>:"/\\|?*]+/g, '');
    if (!stem || stem.length > 220 || stem.startsWith('.') || stem.trim() !== stem || stem.endsWith('.')) return null;
    if (path.basename(stem) !== stem || /[\\/]/.test(stem)) return null;
    return stem;
}

function scopedArtifactStems(scope, legacyValue = '') {
    const primary = scopedArtifactStem(scope);
    const legacy = legacyLocalArtifactStem(legacyValue);
    return legacy && legacy !== primary ? [primary, legacy] : [primary];
}

module.exports = {
    createArchivePowerShellInvocation,
    legacyLocalArtifactStem,
    scopedArtifactStem,
    scopedArtifactStems
};
