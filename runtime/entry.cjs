'use strict';

// The packaged Linux preview uses the existing bootstrap and application. It
// requires an explicit external private root; ordinary Windows startup is kept.
if (process.platform === 'linux' && process.env.SAIL_DEV_ISOLATED === '1') {
    require('./devBootstrap.cjs');
} else {
    require('../main');
}
