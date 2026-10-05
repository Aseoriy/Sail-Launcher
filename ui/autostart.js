'use strict';

function installAutostartControl({ element, ipc, getSupport, getStored, setStored, notice }) {
    let current = false;
    let initialized = false;
    let busy = false;
    element.disabled = true;

    async function initialize() {
        const support = getSupport();
        if (!support.features.autostart.available) return;
        busy = true;
        try {
            current = support.platform === 'linux'
                ? await ipc.invoke('get-autostart')
                : await ipc.invoke('set-autostart', !!getStored());
            element.checked = !!current;
            initialized = true;
            element.disabled = false;
        } catch (error) {
            element.title = 'Start at login could not be checked. Restart Sail to try again.';
            notice(`Start at login could not be checked: ${error.message}`);
        } finally { busy = false; }
    }

    element.addEventListener('change', async () => {
        if (!initialized || busy) { element.checked = !!current; return; }
        const requested = !!element.checked;
        busy = true;
        element.disabled = true;
        try {
            const actual = await ipc.invoke('set-autostart', requested);
            if (actual !== requested) throw new Error('The desktop did not enable the requested startup setting.');
            current = actual;
            element.checked = current;
            setStored(current);
        } catch (error) {
            try { current = await ipc.invoke('get-autostart'); } catch (_) { /* Keep the last observed setting. */ }
            element.checked = !!current;
            notice(`Start at login could not be changed: ${error.message}`);
        } finally {
            busy = false;
            element.disabled = false;
        }
    });
    return { initialize };
}

module.exports = { installAutostartControl };
