'use strict';

function displayText(value, maxLength = 256) {
    return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maxLength);
}

function renderDebridBadge(document, target, statusValue) {
    if (!target) return;
    const status = document.createElement('span');
    status.style.fontSize = '11px';
    if (!statusValue) {
        status.style.opacity = '0.5';
        status.textContent = 'Not connected';
    } else if (statusValue.checking) {
        status.style.color = '#f5a623';
        const spinner = document.createElement('span');
        spinner.className = 'dl-spinner';
        spinner.style.width = '10px';
        spinner.style.height = '10px';
        spinner.style.borderWidth = '2px';
        status.append(spinner, document.createTextNode(' Checking…'));
    } else {
        status.style.color = statusValue.ok ? '#22c55e' : '#ef4444';
        status.style.fontWeight = 'bold';
        status.textContent = statusValue.ok
            ? `✓ Connected${statusValue.user ? ` (${displayText(statusValue.user)})` : ''}`
            : `✕ ${statusValue.error ? displayText(statusValue.error) : 'Invalid key'}`;
    }
    target.replaceChildren(status);
}

function renderDebridServices(document, wrap, services, stateValue, callbacks = {}) {
    if (!wrap) return;
    const state = stateValue && typeof stateValue === 'object' ? stateValue : {};
    const keys = state.keys && typeof state.keys === 'object' ? state.keys : {};
    const statuses = state.status && typeof state.status === 'object' ? state.status : {};
    const onValidate = typeof callbacks.onValidate === 'function' ? callbacks.onValidate : () => {};
    const onClear = typeof callbacks.onClear === 'function' ? callbacks.onClear : () => {};
    wrap.replaceChildren();
    for (const service of Array.isArray(services) ? services.slice(0, 16) : []) {
        const id = displayText(service && service.id, 64);
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) continue;
        const row = document.createElement('div');
        row.style.cssText = 'border:1px solid var(--border-color);border-radius:10px;padding:10px 12px;background:var(--bg-color);';
        const isActive = state.active === id && !!keys[id] && statuses[id] && statuses[id].ok === true;
        const heading = document.createElement('div');
        heading.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;';
        const identity = document.createElement('div');
        identity.style.cssText = 'display:flex;align-items:center;gap:8px;';
        const name = document.createElement('span');
        name.style.cssText = 'font-weight:bold;font-size:13px;';
        name.textContent = displayText(service.name, 80);
        identity.appendChild(name);
        if (isActive) {
            const active = document.createElement('span');
            active.style.cssText = 'font-size:10px;padding:2px 7px;border-radius:99px;background:rgba(34,197,94,0.15);color:#22c55e;font-weight:bold;';
            active.textContent = 'ACTIVE';
            identity.appendChild(active);
        }
        const badge = document.createElement('span');
        badge.className = 'debrid-badge';
        badge.dataset.id = id;
        renderDebridBadge(document, badge, statuses[id]);
        heading.append(identity, badge);

        const controls = document.createElement('div');
        controls.style.cssText = 'display:flex;gap:8px;align-items:center;';
        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.className = 'debrid-key';
        keyInput.dataset.id = id;
        keyInput.placeholder = 'Paste API key…';
        keyInput.value = keys[id] ? String(keys[id]).slice(0, 8192) : '';
        keyInput.style.cssText = 'flex:1;padding:8px 10px;background:var(--card-color, var(--bg-color));border:1px solid var(--border-color);color:var(--text-color);border-radius:7px;box-sizing:border-box;font-size:12px;';
        const connect = document.createElement('button');
        connect.className = 'outline debrid-validate';
        connect.dataset.id = id;
        connect.style.cssText = 'padding:8px 12px;border-radius:7px;font-size:12px;white-space:nowrap;';
        connect.textContent = 'Connect';
        connect.addEventListener('click', () => onValidate(id));
        const clear = document.createElement('button');
        clear.className = 'outline debrid-clear';
        clear.dataset.id = id;
        clear.title = 'Disconnect';
        clear.style.cssText = 'padding:8px 10px;border-radius:7px;font-size:12px;';
        clear.textContent = '✕';
        clear.addEventListener('click', () => onClear(id));
        keyInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                onValidate(id);
            }
        });
        controls.append(keyInput, connect, clear);
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:10px;opacity:0.45;margin-top:5px;';
        hint.textContent = displayText(service.hint, 256);
        row.append(heading, controls, hint);
        wrap.appendChild(row);
    }
}

module.exports = { renderDebridBadge, renderDebridServices };
