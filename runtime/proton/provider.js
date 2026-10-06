'use strict';
const { nativeError } = require('../native/protocol');

class ProtonProvider {
    constructor({ manager, nativeProvider }) { this.manager = manager; this.native = nativeProvider; }
    prepareEnvironment({ scope, gameName, resolve }) {
        this.manager.assertPreparationReady();
        if (!this.native.available || !this.native.scriptsAvailable) throw nativeError('SAIL_PROTON_UNAVAILABLE', 'The installed supervisor cannot prepare UMU.');
        const plan = this.manager.prepareEnvironment({ scope, details: resolve() });
        return this.native.launch({ gameId: scope.gameId, libraryKey: `${scope.profileId}:${scope.libraryId}`, gameName,
            launchMetadata: plan.metadata, resolve: () => plan.resolve(resolve()) });
    }
    launch({ scope, gameName, resolve }) {
        // An old supervisor is refused before any permission is resolved.
        if (!this.native.available || !this.native.scriptsAvailable || !(this.native.windowsTrackingAvailable || this.native.wineTrackingAvailable)) throw nativeError('SAIL_PROTON_UNAVAILABLE', 'The installed supervisor cannot track Windows game images. Rebuild or update Sail before launching.');
        const details = resolve(), wine = details.linuxRuntime?.backend === 'wine';
        this.manager.assertLaunchReady(details.linuxRuntime?.backend);
        if (!(wine ? this.native.wineTrackingAvailable : this.native.windowsTrackingAvailable)) throw nativeError('SAIL_PROTON_UNAVAILABLE', 'The installed supervisor cannot track Windows game images. Rebuild or update Sail before launching.');
        const plan = this.manager.prepare({ scope, details });
        return this.native.launch({ gameId: scope.gameId, libraryKey: `${scope.profileId}:${scope.libraryId}`, gameName,
            launchMetadata: plan.metadata, resolve: () => plan.resolve(resolve()) });
    }
    install({ scope, gameName, resolve, step, installationId, installationStep }) {
        const details = resolve(); this.manager.assertLaunchReady(details.linuxRuntime?.backend);
        if (!this.native.available || !this.native.scriptsAvailable) throw nativeError('SAIL_PROTON_UNAVAILABLE', 'The installed supervisor cannot own a Windows installer.');
        const plan = this.manager.prepareInstallation({ scope, details, installation: { step, id: installationId, index: installationStep } });
        return this.native.launch({ gameId: scope.gameId, libraryKey: `${scope.profileId}:${scope.libraryId}`, gameName,
            launchMetadata: plan.metadata, resolve: () => plan.resolve(resolve()) });
    }
}
module.exports = { ProtonProvider };
