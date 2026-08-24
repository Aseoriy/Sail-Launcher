const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

const SAIL_CLOUD_API = 'https://storage-api.sailhub.fyi';

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function responseBody(response) {
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return { error: text }; }
}

class SailCloudClient {
    constructor({ getAccessToken, apiOrigin = SAIL_CLOUD_API }) {
        this.getAccessToken = getAccessToken;
        this.apiOrigin = apiOrigin.replace(/\/+$/, '');
        this.inFlight = new Map();
    }

    async request(route, options = {}, accessToken = null) {
        accessToken = accessToken || await this.getAccessToken();
        if (!accessToken) throw new Error('Sign in to use Sail Cloud.');
        const headers = {
            Authorization: `Bearer ${accessToken}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {})
        };
        const response = await fetch(`${this.apiOrigin}${route}`, {
            ...options,
            headers,
            body: options.body && typeof options.body !== 'string'
                ? JSON.stringify(options.body)
                : options.body
        });
        const body = await responseBody(response);
        if (!response.ok) {
            const error = new Error(body && body.error || `Sail Cloud request failed (${response.status}).`);
            error.status = response.status;
            error.code = body && body.code || null;
            throw error;
        }
        return body;
    }

    async coalesce(key, operation) {
        const accessToken = await this.getAccessToken();
        if (!accessToken) throw new Error('Sign in to use Sail Cloud.');
        const accountScope = sha256(Buffer.from(String(accessToken), 'utf8'));
        const scopedKey = `${accountScope}:${key}`;
        if (this.inFlight.has(scopedKey)) return this.inFlight.get(scopedKey);
        const task = Promise.resolve().then(() => operation(accessToken));
        this.inFlight.set(scopedKey, task);
        try {
            return await task;
        } finally {
            if (this.inFlight.get(scopedKey) === task) this.inFlight.delete(scopedKey);
        }
    }

    status() {
        return this.coalesce('status', accessToken =>
            this.request('/v1/account-storage/status', {}, accessToken)
        );
    }

    files() {
        return this.coalesce('files', accessToken =>
            this.request('/v1/account-storage/files', {}, accessToken)
        );
    }

    async uploadBytes(payload, bytes) {
        const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
        const digest = sha256(buffer);
        const reservation = await this.request('/v1/account-storage/uploads', {
            method: 'POST',
            body: {
                ...payload,
                sizeBytes: buffer.length,
                sha256: digest
            }
        });
        try {
            const upload = await fetch(reservation.upload_url, {
                method: 'PUT',
                headers: reservation.upload_headers,
                body: buffer
            });
            if (!upload.ok) throw new Error(`R2 upload failed (${upload.status}).`);
            return await this.request(`/v1/account-storage/uploads/${reservation.reservation_id}/complete`, {
                method: 'POST',
                body: { sha256: digest }
            });
        } catch (error) {
            error.reservationId = reservation.reservation_id;
            throw error;
        }
    }

    uploadJson(payload, value) {
        return this.uploadBytes(
            { ...payload, contentType: 'application/json; charset=utf-8' },
            Buffer.from(JSON.stringify(value), 'utf8')
        );
    }

    uploadFile(payload, filePath) {
        const resolved = path.resolve(filePath);
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) throw new Error('The Sail Cloud upload source must be a file.');
        return this.uploadBytes(payload, fs.readFileSync(resolved));
    }

    async downloadArtifact(artifactId, revision = null) {
        const revisionKey = revision === null ? 'latest' : String(revision);
        return this.coalesce(`download:${artifactId}:${revisionKey}`, async accessToken => {
            const metadata = await this.request(`/v1/account-storage/artifacts/${artifactId}/download`, {
                method: 'POST',
                body: revision ? { revision } : {}
            }, accessToken);
            const response = await fetch(metadata.download_url);
            if (!response.ok) throw new Error(`R2 download failed (${response.status}).`);
            const bytes = Buffer.from(await response.arrayBuffer());
            const digest = sha256(bytes);
            if (digest !== metadata.sha256) throw new Error('Downloaded Sail Cloud data failed its SHA-256 check.');
            return { metadata, bytes };
        });
    }

    async downloadArtifactToFile(artifactId, destinationPath, revision = null) {
        const { metadata, bytes } = await this.downloadArtifact(artifactId, revision);
        const resolved = path.resolve(destinationPath);
        fs.ensureDirSync(path.dirname(resolved));
        const temporary = `${resolved}.sail-download-${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(temporary, bytes);
        fs.moveSync(temporary, resolved, { overwrite: true });
        return metadata;
    }

    versions(artifactId) {
        return this.coalesce(`versions:${artifactId}`, accessToken =>
            this.request(`/v1/account-storage/artifacts/${artifactId}/versions`, {}, accessToken)
        );
    }

    deleteArtifact(artifactId) {
        return this.request(`/v1/account-storage/artifacts/${artifactId}`, { method: 'DELETE' });
    }

    deleteProfile(profileId) {
        return this.request(`/v1/account-storage/profiles/${profileId}`, { method: 'DELETE' });
    }
}

module.exports = {
    SAIL_CLOUD_API,
    SailCloudClient,
    sha256
};
