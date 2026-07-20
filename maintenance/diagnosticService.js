'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SENSITIVE_KEY = /(token|secret|api.?key|password|cookie|credential|authorization|email|user.?id|service.?role)/i;

function redactValue(value, key = '', homeDir = '') {
    if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
    if (typeof value === 'string') {
        let output = value;
        if (homeDir) output = output.replace(new RegExp(homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '%USERPROFILE%');
        output = output.replace(/(bearer\s+)[a-z0-9._~+\/-]+/ig, '$1[REDACTED]');
        return output;
    }
    if (Array.isArray(value)) return value.map(item => redactValue(item, key, homeDir));
    if (value && typeof value === 'object') {
        const result = {};
        for (const [childKey, childValue] of Object.entries(value)) result[childKey] = redactValue(childValue, childKey, homeDir);
        return result;
    }
    return value;
}

class DiagnosticService {
    constructor(options = {}) {
        this.homeDir = options.homeDir || require('os').homedir();
        this.version = options.version || '';
    }

    build({ game, manifest, scan, repairAttempts = [], logs = [] }) {
        const report = {
            reportSchemaVersion: 1,
            generatedAt: new Date().toISOString(),
            sailLauncherVersion: this.version,
            game: { id: game.id, title: game.name },
            healthSummary: scan ? scan.summary : null,
            issueCodes: scan ? scan.issues.map(item => item.code) : [],
            manifestVersion: manifest ? manifest.schemaVersion : null,
            installationPath: scan && scan.installRoot || game.installFolder || '',
            executablePath: game.exePath || '',
            scanTimestamps: scan ? { startedAt: scan.startedAt, completedAt: scan.completedAt } : null,
            fileFindings: scan ? scan.issues.filter(item => item.path).map(item => ({ code: item.code, severity: item.severity, path: item.path, details: item.details })) : [],
            repairAttempts,
            dependencyFindings: scan ? scan.dependencies : [],
            logs
        };
        return redactValue(report, '', this.homeDir);
    }

    async write(report, destination) {
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        const temp = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
            await fs.promises.writeFile(temp, JSON.stringify(report, null, 2), 'utf8');
            await fs.promises.rename(temp, destination);
        } finally { await fs.promises.rm(temp, { force: true }).catch(() => {}); }
        return destination;
    }
}

module.exports = { DiagnosticService, redactValue };
