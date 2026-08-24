(function () {
    'use strict';

    const queue = [];
    let active = false;
    let activeDialog = null;

    function classify(message, requestedTone) {
        if (requestedTone) return requestedTone;
        const value = String(message || '').toLowerCase();
        if (/delete|remove|overwrite|reset|clear|hide all|warning|cannot be undone|failed|error|permanent/.test(value)) return 'danger';
        if (/success|complete|exported|linked|up to date/.test(value)) return 'success';
        return 'info';
    }

    function labels(tone, kind, options) {
        if (options.confirmText) return options.confirmText;
        if (kind === 'alert') return 'Got it';
        if (tone === 'danger') return 'Continue';
        return 'Confirm';
    }

    function iconFor(tone, kind) {
        if (tone === 'danger') return '!';
        if (tone === 'success') return '✓';
        return kind === 'confirm' ? '?' : 'i';
    }

    function choiceIcon(name) {
        const icons = {
            file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"></path><path d="M14 2v6h6M8 13h8M8 17h6"></path></svg>',
            folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a3 3 0 0 1-3 3H5a2 2 0 0 1-2-2Z"></path><path d="M3 9h18"></path></svg>'
        };
        return icons[name] || icons.file;
    }

    function runNext() {
        if (active || !queue.length) return;
        active = true;
        const request = queue.shift();
        const options = request.options || {};
        const tone = classify(options.message, options.tone);
        const kind = options.kind || 'alert';
        const dialogState = { key: options.dialogKey || '', kind, finish: null };
        activeDialog = dialogState;
        const layer = document.createElement('div');
        layer.className = 'sail-dialog-layer';
        layer.setAttribute('role', 'presentation');

        const card = document.createElement('section');
        card.className = 'sail-dialog-card';
        card.dataset.tone = tone;
        card.setAttribute('role', kind === 'alert' ? 'alertdialog' : 'dialog');
        card.setAttribute('aria-modal', 'true');

        const body = document.createElement('div');
        body.className = 'sail-dialog-body';
        const icon = document.createElement('div');
        icon.className = 'sail-dialog-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = iconFor(tone, kind);
        const copy = document.createElement('div');
        copy.className = 'sail-dialog-copy';
        const eyebrow = document.createElement('div');
        eyebrow.className = 'sail-dialog-eyebrow';
        eyebrow.textContent = options.eyebrow || 'Sail Launcher';
        const title = document.createElement('h2');
        title.className = 'sail-dialog-title';
        title.id = `sail-dialog-title-${Date.now()}`;
        title.textContent = options.title || (tone === 'danger' ? 'Please confirm' : tone === 'success' ? 'All set' : kind === 'confirm' ? 'Quick confirmation' : 'Heads up');
        const message = document.createElement('div');
        message.className = 'sail-dialog-message';
        message.textContent = String(options.message == null ? '' : options.message).replace(/^[✅❌ℹ️⚠️]+\s*/u, '');
        copy.append(eyebrow, title, message);

        const choiceButtons = [];
        if (kind === 'choice') {
            const choiceList = document.createElement('div');
            choiceList.className = 'sail-dialog-choice-list';
            (Array.isArray(options.choices) ? options.choices : []).forEach((choice, index) => {
                if (!choice || choice.value == null) return;
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'sail-dialog-choice';
                button.dataset.choiceIndex = String(index);
                const icon = document.createElement('span');
                icon.className = 'sail-dialog-choice-icon';
                icon.innerHTML = choiceIcon(choice.icon);
                const choiceCopy = document.createElement('span');
                choiceCopy.className = 'sail-dialog-choice-copy';
                const label = document.createElement('strong');
                label.textContent = String(choice.label || choice.value);
                choiceCopy.appendChild(label);
                if (choice.description) {
                    const description = document.createElement('small');
                    description.textContent = String(choice.description);
                    choiceCopy.appendChild(description);
                }
                button.append(icon, choiceCopy);
                choiceList.appendChild(button);
                choiceButtons.push({ button, value: choice.value });
            });
            copy.appendChild(choiceList);
        }

        let input = null;
        if (kind === 'prompt') {
            input = document.createElement('input');
            input.className = 'sail-dialog-input';
            input.value = options.defaultValue || '';
            input.placeholder = options.placeholder || '';
            copy.appendChild(input);
        }
        body.append(icon, copy);

        const actions = document.createElement('div');
        actions.className = 'sail-dialog-actions';
        let cancelButton = null;
        if (kind !== 'alert') {
            cancelButton = document.createElement('button');
            cancelButton.type = 'button';
            cancelButton.className = 'outline sail-dialog-cancel';
            cancelButton.textContent = options.cancelText || 'Cancel';
            actions.appendChild(cancelButton);
        }
        let primary = null;
        if (kind !== 'choice') {
            primary = document.createElement('button');
            primary.type = 'button';
            primary.className = 'sail-dialog-primary';
            primary.textContent = labels(tone, kind, options);
            actions.appendChild(primary);
        }
        card.append(body, actions);
        card.setAttribute('aria-labelledby', title.id);
        layer.appendChild(card);
        document.body.appendChild(layer);

        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            layer.classList.add('is-closing');
            setTimeout(() => {
                layer.remove();
                active = false;
                if (activeDialog === dialogState) activeDialog = null;
                request.resolve(value);
                runNext();
            }, 170);
        };
        dialogState.finish = finish;
        const accept = () => finish(kind === 'prompt' ? input.value : true);
        const cancel = () => finish(kind === 'prompt' || kind === 'choice' ? null : false);
        const onKey = event => {
            if (event.key === 'Escape') { event.preventDefault(); kind === 'alert' ? accept() : cancel(); }
            if (event.key === 'Enter' && event.target && event.target.closest && event.target.closest('.sail-dialog-choice')) {
                event.preventDefault();
                const choice = choiceButtons.find(item => item.button === event.target.closest('.sail-dialog-choice'));
                if (choice) finish(choice.value);
                return;
            }
            if (event.key === 'Enter' && (!input || event.target === input)) { event.preventDefault(); accept(); }
            if (event.key === 'Tab') {
                const focusable = [...choiceButtons.map(item => item.button), cancelButton, primary].filter(Boolean);
                if (input) focusable.unshift(input);
                if (!focusable.length) return;
                const current = focusable.indexOf(document.activeElement);
                event.preventDefault();
                focusable[(current + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length].focus();
            }
        };
        if (primary) primary.addEventListener('click', accept);
        if (cancelButton) cancelButton.addEventListener('click', cancel);
        choiceButtons.forEach(choice => choice.button.addEventListener('click', () => finish(choice.value)));
        layer.addEventListener('mousedown', event => { if (event.target === layer && kind !== 'alert') cancel(); });
        document.addEventListener('keydown', onKey, true);
        requestAnimationFrame(() => (input || choiceButtons[0]?.button || primary || cancelButton)?.focus());
    }

    function enqueue(options) {
        return new Promise(resolve => {
            queue.push({ options, resolve });
            runNext();
        });
    }

    window.sailAlert = (message, options = {}) => enqueue(Object.assign({}, options, { kind: 'alert', message }));
    window.sailConfirm = (message, options = {}) => enqueue(Object.assign({}, options, { kind: 'confirm', message }));
    window.sailPrompt = (message, defaultValue = '', options = {}) => enqueue(Object.assign({}, options, { kind: 'prompt', message, defaultValue }));
    window.sailChoice = (message, choices, options = {}) => enqueue(Object.assign({}, options, { kind: 'choice', message, choices }));
    window.dismissSailAlert = dialogKey => {
        if (activeDialog && activeDialog.kind === 'alert' && activeDialog.finish && (!dialogKey || activeDialog.key === dialogKey)) {
            activeDialog.finish(true);
            return true;
        }
        const queuedIndex = queue.findIndex(request => {
            const options = request.options || {};
            return options.kind === 'alert' && dialogKey && options.dialogKey === dialogKey;
        });
        if (queuedIndex < 0) return false;
        const [request] = queue.splice(queuedIndex, 1);
        request.resolve(true);
        return true;
    };

    // Route legacy alerts through the themed system. Confirmation call sites use
    // sailConfirm explicitly because a custom dialog cannot synchronously block Chromium.
    window.alert = message => { void window.sailAlert(message); };
})();
