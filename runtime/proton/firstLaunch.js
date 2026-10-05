'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { scopeKey, privateDirectory, privateRead, save } = require('./manager');
const packages = require('./prerequisitePackages');
const { recommendations } = require('./recommendations');
const { UUID } = require('../native/protocol');
const ACTIVE_DOWNLOAD = new Set(['checking', 'downloading', 'extracting', 'queuing', 'installing']);
const ACTIVE_INSTALL = new Set(['checking', 'starting', 'running', 'waiting', 'tracking-lost']);

class FirstLaunch {
    constructor({ manager, enabled = false }) { this.manager = manager; this.enabled = enabled; this.root = path.join(manager.root, 'first-launch'); }
    read(scope) {
        if (!fs.existsSync(this.root)) return null;
        privateDirectory(this.manager.root); privateDirectory(this.root);
        const file = path.join(this.root, scopeKey(scope) + '.json'); if (!fs.existsSync(file)) return null;
        const record = JSON.parse(privateRead(file, 16384));
        if (record.protocol !== 1 || scopeKey(record.scope) !== scopeKey(scope) || !/^[a-f0-9]{64}$/.test(record.fingerprint)
            || !['skip', 'setup'].includes(record.decision) || !Array.isArray(record.recipeIds) || record.recipeIds.length > packages.MAX_RECIPES
            || new Set(record.recipeIds).size !== record.recipeIds.length || !Number.isSafeInteger(record.reviewedAt)
            || (record.completed !== undefined && typeof record.completed !== 'boolean')
            || (record.decision === 'setup' && (!UUID.test(record.jobId) || !record.recipeIds.length))) throw Error('First-launch setup needs repair. Existing game files were kept.');
        record.recipeIds.forEach(packages.recipe); return record;
    }
    remember(scope, fingerprint, decision, recipeIds = [], jobId = '') {
        privateDirectory(this.manager.root, true); privateDirectory(this.root, true);
        const file = path.join(this.root, scopeKey(scope) + '.json');
        if (!fs.existsSync(file) && fs.readdirSync(this.root).length >= 256) throw Error('Too many first-launch setup records.');
        save(file, JSON.stringify({ protocol: 1, scope: { ...scope }, fingerprint, decision, recipeIds, jobId, completed: false, reviewedAt: Date.now() }) + '\n');
    }
    plan({ scope, details, roots = [] }) {
        if (!this.enabled) return { available: false, reviewRequired: false };
        if (details.linuxRuntime?.backend === 'wine' && !this.manager.wineLaunchReadiness().available) return { available: false, reviewRequired: false, reason: require('./wine').WINE_PENDING_REASON };
        const installation = this.manager.installations.status(scope), online = this.manager.prerequisites.status(scope);
        if (ACTIVE_INSTALL.has(installation?.phase) || ACTIVE_DOWNLOAD.has(online.job?.phase)) return { available: true, busy: true,
            reviewRequired: true, installation, online, reason: 'Wait for setup to finish, or cancel it before playing.' };
        const runtime = this.manager.runtime(details.linuxRuntime.runtimeId), recommendation = recommendations(details, this.manager, roots);
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ protocol: 1, scope, details,
            runtime: runtime.backend === 'wine' ? { id: runtime.id, backend: 'wine', wine: runtime.wineIdentity, server: runtime.serverIdentity, loaders: runtime.loaders, root: runtime.rootIdentity }
                : { id: runtime.id, umu: runtime.umuIdentity, proton: runtime.protonIdentity, root: runtime.rootIdentity },
            recipes: packages.recipes.map(item => [item.id, item.sha256]), evidence: recommendation.evidence })).digest('hex');
        const components = packages.probe(this.manager, scope, runtime.id).map(item => ({ ...item,
            recommended: !!recommendation.reasons[item.id], reasons: recommendation.reasons[item.id] || [] }));
        const missing = components.filter(item => item.recommended && item.detection === 'not-detected');
        const unknown = components.filter(item => item.recommended && item.detection === 'unknown');
        const record = this.read(scope), matched = record?.fingerprint === fingerprint;
        const previousSetup = matched && record.decision === 'setup';
        const detected = previousSetup && record.recipeIds.every(id => components.find(item => item.id === id)?.detection === 'detected');
        const receiptCompleted = previousSetup && online.job?.id === record.jobId && online.job.phase === 'completed';
        const completed = detected && (record.completed === true || receiptCompleted);
        if (completed && record.completed !== true) {
            save(path.join(this.root, scopeKey(scope) + '.json'), JSON.stringify({ ...record, completed: true }) + '\n');
        }
        const skipped = matched && record.decision === 'skip';
        return { available: true, busy: false, fingerprint, runtimeId: runtime.id, runtimeLabel: runtime.label,
            components, warnings: recommendation.warnings, guidance: recommendation.guidance, recipeIds: missing.map(item => item.id), unknownIds: unknown.map(item => item.id),
            reviewRequired: !skipped && !completed && (!!missing.length || !!unknown.length || !!previousSetup),
            previousInterrupted: !!previousSetup && !completed, skipped, completed,
            reason: previousSetup && !completed ? 'Previous setup changed or its components could not be confirmed. Review before continuing.'
                : unknown.length ? 'Some recommended components could not be checked. Review them in Manage Game.'
                : missing.length ? 'Missing components were suggested for this game.' : 'No supported missing components were identified. Other game requirements may still need manual setup.' };
    }
}
module.exports = { FirstLaunch };
