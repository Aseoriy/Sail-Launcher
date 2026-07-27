(() => {
    const API_ORIGIN = 'https://storage-api.sailhub.fyi';

    async function hashFile(file) {
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function api(route, options = {}) {
        if (!window.sailSupabase) throw new Error('Sail Hub authentication is not ready.');
        const { data: { session } } = await window.sailSupabase.auth.getSession();
        if (!session || !session.access_token) throw new Error('Sign in to upload Sail Hub assets.');
        const response = await fetch(`${API_ORIGIN}${route}`, {
            ...options,
            headers: {
                Authorization: `Bearer ${session.access_token}`,
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...(options.headers || {})
            },
            body: options.body && typeof options.body !== 'string'
                ? JSON.stringify(options.body)
                : options.body
        });
        const text = await response.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch (_) { body = { error: text }; }
        if (!response.ok) throw new Error(body && body.error || `Sail Hub storage failed (${response.status}).`);
        return body;
    }

    async function stage(file, itemId, kind) {
        if (!(file instanceof File)) throw new Error('Choose a file to upload.');
        const extension = (file.name.split('.').pop() || '').toLowerCase();
        const sha256 = await hashFile(file);
        const reservation = await api('/v1/hub-assets/uploads', {
            method: 'POST',
            body: {
                itemId,
                kind,
                sizeBytes: file.size,
                contentType: file.type || 'application/octet-stream',
                sha256,
                extension
            }
        });
        const upload = await fetch(reservation.upload_url, {
            method: 'PUT',
            headers: reservation.upload_headers,
            body: file
        });
        if (!upload.ok) throw new Error(`Cloudflare R2 upload failed (${upload.status}).`);
        return { ...reservation, sha256 };
    }

    function complete(staged) {
        return api(`/v1/hub-assets/uploads/${staged.reservation_id}/complete`, {
            method: 'POST',
            body: { sha256: staged.sha256 }
        });
    }

    function remove(itemId, kind) {
        return api(`/v1/hub-assets/items/${itemId}/${kind}`, { method: 'DELETE' });
    }

    function migrateLegacy(itemId) {
        return api('/v1/hub-assets/migrate-legacy', {
            method: 'POST',
            body: { itemId }
        });
    }

    window.SailHubAssets = { stage, complete, remove, migrateLegacy };
})();
