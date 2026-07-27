(() => {
    const style = document.createElement('style');
    style.textContent = `
        .sail-secret-field { position:relative; width:100%; min-width:0; flex:1 1 auto; }
        .sail-secret-field > input { width:100%; padding-right:44px !important; }
        .sail-secret-toggle {
            position:absolute; top:50%; right:6px; width:34px; height:34px; min-height:0; padding:0;
            transform:translateY(-50%); border:0; border-radius:8px; color:inherit;
            background:transparent; box-shadow:none; opacity:.68; display:grid; place-items:center; cursor:pointer;
            margin:0; animation:none; transition:opacity .12s ease,background-color .12s ease;
        }
        .sail-secret-toggle:hover,.sail-secret-toggle:focus-visible,.sail-secret-toggle:active {
            transform:translateY(-50%); opacity:1; background:rgba(168,85,247,.12); outline:none;
            box-shadow:none; margin:0;
        }
        .sail-secret-toggle svg { width:18px; height:18px; pointer-events:none; }
    `;
    document.head.appendChild(style);

    const eye = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12"></path>
            <circle cx="12" cy="12" r="3"></circle>
        </svg>`;
    const eyeOff = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m3 3 18 18"></path><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"></path>
            <path d="M9.9 4.2A11 11 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.1 3.2"></path>
            <path d="M6.6 6.6C3.6 8.5 2 12 2 12s3.5 8 10 8a10 10 0 0 0 4.1-.9"></path>
        </svg>`;

    function enhance(root = document) {
        root.querySelectorAll('input[type="password"]:not([data-no-secret-toggle]):not([data-secret-toggle-ready])').forEach(input => {
            input.dataset.secretToggleReady = 'true';
            const wrapper = document.createElement('span');
            wrapper.className = 'sail-secret-field';
            input.parentNode.insertBefore(wrapper, input);
            wrapper.appendChild(input);

            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'sail-secret-toggle';
            button.setAttribute('aria-label', 'Show hidden text');
            button.setAttribute('aria-pressed', 'false');
            button.title = 'Show hidden text';
            button.innerHTML = eye;
            button.addEventListener('click', () => {
                const revealed = input.type === 'text';
                input.type = revealed ? 'password' : 'text';
                button.innerHTML = revealed ? eye : eyeOff;
                button.setAttribute('aria-pressed', String(!revealed));
                button.setAttribute('aria-label', revealed ? 'Show hidden text' : 'Hide text');
                button.title = revealed ? 'Show hidden text' : 'Hide text';
                input.focus({ preventScroll:true });
            });
            wrapper.appendChild(button);
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => enhance());
    else enhance();
    new MutationObserver(records => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) enhance(node);
            }
        }
    }).observe(document.documentElement, { childList:true, subtree:true });
})();
