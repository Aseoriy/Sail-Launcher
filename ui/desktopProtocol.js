'use strict';

function installDesktopProtocol({ document, ipc, getSupport, notice }) {
    const handled = new Set();
    ipc.on('desktop-protocol-activation', (_event, request) => {
        if (!request || typeof request.requestId !== 'string' || handled.has(request.requestId)) return;
        handled.add(request.requestId);
        if (handled.size > 32) handled.delete(handled.values().next().value);
        try {
            if (request.action === 'unavailable') notice(request.message);
            else if (request.action === 'cloud-callback') ipc.emit('account-cloud-callback', {}, request);
            else if (request.action === 'install-theme' || request.action === 'install-plugin') ipc.emit('hub-install', {}, request);
        } finally {
            ipc.invoke('desktop-protocol-ack', request.requestId).catch(() => {});
        }
    });

    async function initialize() {
        const support = getSupport();
        if (support.platform !== 'linux' || support.isolated) return;
        const host = document.getElementById('tab-system');
        if (!host) return;
        const block = document.createElement('div');
        block.style.marginBottom = '20px';
        const button = document.createElement('button');
        button.id = 'registerSailLinksBtn';
        button.type = 'button';
        button.textContent = 'Use Sail Launcher for Sail links';
        const status = document.createElement('p');
        status.id = 'sailLinksStatus';
        status.setAttribute('role', 'status');
        status.style.cssText = 'font-size:12px;margin-top:8px;';
        block.append(button, status);
        host.append(block);
        button.disabled = true;
        if (!support.features.desktopIntegration.available) {
            status.textContent = support.features.desktopIntegration.reason;
            return;
        }
        const display = result => {
            status.textContent = result.registered ? 'Sail Launcher handles Sail links.'
                : result.configured ? 'Sail’s application entry exists. Another application handles Sail links.'
                    : 'Sail links are not registered for this installation.';
        };
        try { display(await ipc.invoke('desktop-protocol-status')); }
        catch (error) { status.textContent = error.message || 'Sail link registration could not be read.'; }
        button.disabled = false;
        button.addEventListener('click', async () => {
            button.disabled = true;
            try { display(await ipc.invoke('desktop-register-protocol')); }
            catch (error) {
                status.textContent = error.message || 'Sail links could not be registered.';
                notice(status.textContent);
            } finally { button.disabled = false; }
        });
    }

    return { initialize, ready: () => ipc.invoke('desktop-protocol-ready') };
}

module.exports = { installDesktopProtocol };
