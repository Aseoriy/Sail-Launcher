'use strict';
if (process.env.SAIL_DEV_ISOLATED === '1') {
    require('node:os').homedir = () => process.env.SAIL_DEV_HOME;
    require('./offlineNetwork').installOfflineNodeNetwork();
}
