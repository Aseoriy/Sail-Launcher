'use strict';

function createRemoteDataClient(ipcRenderer) {
    if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') {
        throw new TypeError('Remote data access requires an IPC renderer.');
    }

    async function invoke(payload) {
        const result = await ipcRenderer.invoke('remote-data', payload);
        if (!result || result.ok !== true) {
            throw new Error(result && typeof result.error === 'string'
                ? result.error
                : 'The remote data request failed.');
        }
        return result;
    }

    return Object.freeze({
        async searchSteamApps(query) {
            return (await invoke({ operation: 'steam.searchApps', query })).data;
        },
        async getSteamFriendList(apiKey, steamId) {
            return (await invoke({ operation: 'steam.friendList', apiKey, steamId })).data;
        },
        async getSteamPlayerSummaries(apiKey, steamIds) {
            return (await invoke({ operation: 'steam.playerSummaries', apiKey, steamIds })).data;
        },
        async getSteamAppDetails(appId, language) {
            return (await invoke({ operation: 'steam.appDetails', appId, language })).data;
        },
        async searchSteamStore(query) {
            return (await invoke({ operation: 'steam.storeSearch', query })).data;
        },
        async searchDownloadSource(source, query) {
            return invoke({ operation: 'source.search', source, query });
        },
        async getDownloadSourceDetail(reference) {
            return invoke({ operation: 'source.detail', reference });
        }
    });
}

module.exports = { createRemoteDataClient };
