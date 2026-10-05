'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const native = require('../native/protocol');
const { validateWindowsExecutable } = require('./executable');
const { fileVersion } = require('./peVersion');

// These switches apply only to these recognized bundled installers. A file
// name is not publisher verification; main asks the user to approve the files.
function recipe(name, version = '') {
    const vc = /^vc_redist\.(x86|x64)\.exe$/i.exec(name);
    if (vc) return { kind: 'visual-cpp', label: `Visual C++ (${vc[1].toLowerCase()})`, argv: ['/install', '/quiet', '/norestart'] };
    if (/^dxsetup\.exe$/i.test(name)) return { kind: 'directx', label: 'DirectX bundled components', argv: ['/silent'] };
    const legacy = /^vcredist[_\.](x86|x64)\.exe$/i.exec(name), year = { 10: 2010, 11: 2012, 12: 2013 }[version.split('.')[0]];
    if (legacy && year) return { kind: 'visual-cpp', label: `Visual C++ ${year} (${legacy[1].toLowerCase()})`,
        argv: year === 2010 ? ['/q', '/norestart'] : ['/install', '/quiet', '/norestart'], recipeId: `vcrun${year}-${legacy[1].toLowerCase()}` };
    return null;
}
function officialRecipe(item) {
    const known = item.argv ? { kind: item.kind, argv: item.argv } : recipe(item.installerName);
    if (!known || known.kind !== item.kind) throw Error('The official prerequisite recipe is unavailable.');
    return { ...known, label: item.label };
}
function bundledRecipe(file, expected = null) {
    const name = path.basename(file), known = recipe(name); if (known) return known;
    if (!/^vcredist[_\.](x86|x64)\.exe$/i.test(name)) return null;
    return recipe(name, fileVersion(file, { expected }).version);
}
function installer(selected, { fixtureRoot = null, expected = null, kind = 'installer', argv = [], label } = {}) {
    const executable = validateWindowsExecutable(selected, { fixtureRoot, expected });
    const cwd = native.validateWorkingDirectory(path.dirname(executable.realPath), { fixtureRoot });
    return { kind, label: label || path.basename(executable.realPath), executable, cwd, argv: native.validateArgv(argv) };
}
function validateStep(step, options = {}) {
    if (!step || !['installer', 'visual-cpp', 'directx'].includes(step.kind) || typeof step.label !== 'string'
        || step.label.length > 200 || /[\u0000-\u001f\u007f]/.test(step.label)) throw Error('Invalid Windows installation step.');
    if (step.kind !== 'installer') {
        const known = step.officialRecipeId !== undefined ? officialRecipe(require('./prerequisitePackages').recipe(step.officialRecipeId))
            : bundledRecipe(step.executable?.realPath || '', step.executable);
        if (!known || known.kind !== step.kind || JSON.stringify(known.argv) !== JSON.stringify(step.argv)) throw Error('The prerequisite installation recipe changed.');
    } else if (!Array.isArray(step.argv) || step.argv.length) throw Error('A selected installer opens its own setup interface.');
    const executable = validateWindowsExecutable(step.executable?.realPath, { ...options, expected: step.executable });
    native.validateWorkingDirectory(step.cwd?.realPath, { ...options, expected: step.cwd });
    if (step.cwd.realPath !== path.dirname(executable.realPath)) throw Error('The installer working folder changed.');
    if (step.officialRecipeId !== undefined) {
        const packages = require('./prerequisitePackages'), item = packages.recipe(step.officialRecipeId);
        const root = path.join(options.root, 'prerequisites', 'cache', item.id + '-' + item.sha256);
        if (step.kind !== item.kind || executable.realPath !== path.join(root, item.installerName)) throw Error('The official prerequisite installation changed.');
        packages.verifyPayload(root, item);
    }
    return step;
}
function discover({ executablePath, workingDirectory, fixtureRoot = null }) {
    const candidates = [], issues = [], seen = new Set(); let visited = 0, truncated = false;
    const roots = [...new Set([path.dirname(executablePath), workingDirectory])];
    const add = file => {
        if (!/^(?:vc_redist\.(?:x86|x64)|vcredist[_\.](?:x86|x64)|dxsetup)\.exe$/i.test(path.basename(file))) return;
        try {
            const selected = installer(file, { fixtureRoot }), known = bundledRecipe(file, selected.executable); if (!known) return;
            const step = { ...selected, ...known };
            const id = crypto.createHash('sha256').update(JSON.stringify([step.kind, step.executable])).digest('hex');
            if (!seen.has(id)) { seen.add(id); candidates.push({ id, ...step }); }
        } catch (_) { if (issues.length < 8) issues.push('A bundled prerequisite could not be validated.'); }
    };
    const walk = (folder, root, depth, insideBundle = false) => {
        if (depth > 5 || visited >= 4096 || candidates.length >= 16) { truncated = true; return; }
        try {
            const stat = fs.lstatSync(folder);
            if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(folder) !== folder || !native.withinRoot(folder, root)) return;
            const dir = fs.opendirSync(folder);
            try {
                let entry;
                while ((entry = dir.readSync())) {
                    if (++visited > 4096 || candidates.length >= 16) { truncated = true; break; }
                    const file = path.join(folder, entry.name);
                    if (entry.isFile()) add(file);
                    else if (entry.isDirectory() && (insideBundle || /^(?:_?commonredist|_?redist|redistributables|directx|vcredist)$/i.test(entry.name))) {
                        walk(file, root, depth + 1, true);
                    }
                }
            } finally { dir.closeSync(); }
        } catch (_) { if (issues.length < 8) issues.push('A prerequisite folder could not be read.'); }
    };
    for (const root of roots) {
        native.validateWorkingDirectory(root, { fixtureRoot }); walk(root, root, 0);
    }
    candidates.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label) || a.executable.realPath.localeCompare(b.executable.realPath));
    return { candidates, issues, truncated };
}
module.exports = { recipe, officialRecipe, installer, validateStep, discover };
