'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const TARGET = 'howlongtobeat-js@1.0.2';
const COLLECTOR_SHA256 = '490b05e03bb2276dea3e965213cb15d088fea796db733c995b1e4a8d67b814c3';
const PACKAGE_SHA256 = '23aa14a36757b93e088152ed948b2031ba5ffce47025d8c214e717d93cbd08c9';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function correctGraph(graph) {
    const fail = message => { throw new Error(`Sail build graph correction refused: ${message}`); };
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) fail('unexpected graph');
    const corrected = {};
    for (const [key, node] of Object.entries(graph)) {
        if (!node || !Array.isArray(node.dependencies) || !node.dependencies.every(id => typeof id === 'string' && Object.hasOwn(graph, id))) fail('unexpected dependency graph shape');
        corrected[key] = { ...node, dependencies: [...node.dependencies] };
    }
    const target = corrected[TARGET];
    if (!target || target.dependencies.filter(id => id === TARGET).length !== 1) fail('expected exactly one known self-edge');
    target.dependencies = target.dependencies.filter(id => id !== TARGET);
    // Reject any other cycle. Never suppress legitimate repeated placements or
    // silently generalize this workaround to new dependencies/versions.
    const visiting = new Set(), visited = new Set();
    function visit(key) {
        if (visiting.has(key)) fail(`unexpected cycle at ${key}`);
        if (visited.has(key)) return;
        visiting.add(key);
        for (const dependency of corrected[key].dependencies) visit(dependency);
        visiting.delete(key); visited.add(key);
    }
    for (const key of Object.keys(corrected)) visit(key);
    return corrected;
}

function verifyIdentity(root) {
    const builderFile = require.resolve('app-builder-lib/package.json', { paths: [root] });
    const builderRoot = path.dirname(builderFile);
    const collectorFile = path.join(builderRoot, 'out/node-module-collector/nodeModulesCollector.js');
    const packageFile = require.resolve('howlongtobeat-js/package.json', { paths: [root] });
    const packageRoot = fs.realpathSync(path.dirname(packageFile));
    const pkgBytes = fs.readFileSync(packageFile), pkg = JSON.parse(pkgBytes);
    if (JSON.parse(fs.readFileSync(builderFile)).version !== '26.15.3'
        || hash(fs.readFileSync(collectorFile)) !== COLLECTOR_SHA256
        || pkg.version !== '1.0.2' || pkg.dependencies['howlongtobeat-js'] !== '^1.0.1'
        || hash(pkgBytes) !== PACKAGE_SHA256
        || packageRoot !== fs.realpathSync(path.join(root, 'node_modules/howlongtobeat-js'))) {
        throw new Error('Sail build graph correction refused: installed builder/package identity changed; review or remove the scoped adapter.');
    }
    return { collectorFile, packageRoot };
}

function installBuilderGraphCorrection(root, receipt = value => console.log(`SAIL_BUILD_GRAPH ${JSON.stringify(value)}`)) {
    const { collectorFile, packageRoot } = verifyIdentity(root);
    const { NodeModulesCollector } = require(collectorFile);
    const prototype = NodeModulesCollector.prototype;
    const originalTransform = prototype.transformToHoisterTree;
    const originalCollect = prototype.getNodeModules;
    const correctedInstances = new WeakSet();
    prototype.transformToHoisterTree = function (graph, key, nodes) {
        if (nodes !== undefined) return originalTransform.call(this, graph, key, nodes);
        if (correctedInstances.has(this)) throw new Error('Sail build graph correction refused: repeated application.');
        const actual = this.allDependencies.get(TARGET);
        if (!actual || actual.version !== '1.0.2' || !actual.path || fs.realpathSync(actual.path) !== packageRoot) {
            throw new Error('Sail build graph correction refused: unexpected graph package identity.');
        }
        const corrected = correctGraph(graph);
        correctedInstances.add(this);
        receipt({ adapter: 1, collectorSha256: COLLECTOR_SHA256, packageSha256: PACKAGE_SHA256,
            removedEdge: [TARGET, TARGET], originalGraphSha256: hash(JSON.stringify(graph)),
            correctedGraphSha256: hash(JSON.stringify(corrected)), nodes: Object.keys(graph).length });
        return originalTransform.call(this, corrected, key);
    };
    prototype.getNodeModules = async function (...args) {
        const result = await originalCollect.apply(this, args);
        if (!correctedInstances.has(this)) throw new Error('Sail build graph correction was not applied.');
        const placements = [];
        const visit = (entries, parent) => { for (const entry of entries) {
            const destination = `${parent}node_modules/${entry.name}`;
            placements.push({ destination, name: entry.name, version: entry.version, source: path.relative(root, entry.dir) });
            if (entry.dependencies) visit(entry.dependencies, destination + '/');
        } };
        visit(result.nodeModules, ''); receipt({ placements });
        return result;
    };
    return () => { prototype.transformToHoisterTree = originalTransform; prototype.getNodeModules = originalCollect; };
}

module.exports = { correctGraph, installBuilderGraphCorrection, verifyIdentity, TARGET };
