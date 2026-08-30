'use strict';

function createRemoteDataClient(ipcRenderer) {
    if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') {
        throw new TypeError('Remote data access requires an IPC renderer.');
    }

    const inFlight = new Map();

    async function invoke(payload) {
        const result = await ipcRenderer.invoke('remote-data', payload);
        if (!result || result.ok !== true) {
            throw new Error(result && typeof result.error === 'string'
                ? result.error
                : 'The remote data request failed.');
        }
        return result;
    }

    function invokeCoalesced(key, payload) {
        const existing = inFlight.get(key);
        if (existing) return existing;
        const pending = invoke(payload).finally(() => {
            if (inFlight.get(key) === pending) inFlight.delete(key);
        });
        inFlight.set(key, pending);
        return pending;
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
        async searchDownloadSource(source, query, page) {
            const payload = { operation: 'source.search', source, query };
            if (page !== undefined) payload.page = page;
            return invokeCoalesced(`source.search\n${source}\n${query}\n${page || 1}`, payload);
        },
        async getFitGirlSearchCovers(query, page) {
            const payload = { operation: 'source.fitgirlCovers', query };
            if (page !== undefined) payload.page = page;
            return invokeCoalesced(`source.fitgirlCovers\n${query}\n${page || 1}`, payload);
        },
        async getDownloadSourceDetail(reference) {
            return invoke({ operation: 'source.detail', reference });
        }
    });
}

module.exports = { createRemoteDataClient };
