'use strict';

const path = require('node:path');
const root = path.resolve(__dirname, '..');
if (path.resolve(process.cwd()) !== root) throw new Error('Run Sail builds from the checkout root.');
require('../runtime/installedElectron').installedElectron();
if (process.argv.includes('--linux')) require('./build-native.cjs').buildNative();
require('./builderGraphCorrection.cjs').installBuilderGraphCorrection(root);
require('electron-builder/cli.js');
