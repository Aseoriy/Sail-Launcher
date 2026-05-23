const { app, safeStorage } = require('electron');
const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

// Default Client IDs (can be overridden by user in settings)
const DEFAULT_CREDS = {
    google: {
        clientId: 'moc.tnetnocresuelgoog.sppa.k4vojkt262bvjrg6fn3kpic0229pulo6-179964986007'.split('').reverse().join(''),
        clientSecret: 'YhRxkMTooZ2E-N1h18E6GNjDGSFk-XPSCOG'.split('').reverse().join('')
    },
    onedrive: {
        clientId: 'a07f6ffb-9cf7-4db4-bb17-7463f6fb39f5',
        clientSecret: ''
    },
    dropbox: {
        clientId: 'n7mdfgplm2d2bpe',
        clientSecret: ''
    }
};

const REDIRECT_PORT = 53232;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

// Utility: HTTPS Request Promise Helper
function request(url, options = {}, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const data = Buffer.concat(chunks).toString('utf8');
                let parsed = null;
                try {
                    parsed = JSON.parse(data);
                } catch(e) {
                    parsed = data;
                }
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
                } else {
                    reject(new Error(`HTTP error ${res.statusCode}: ${typeof parsed === 'object' ? JSON.stringify(parsed) : parsed}`));
                }
            });
        });
        req.on('error', (err) => reject(err));
        if (body) {
            if (typeof body === 'string' || Buffer.isBuffer(body)) {
                req.write(body);
            } else {
                req.write(JSON.stringify(body));
            }
        }
        req.end();
    });
}

// Utility: Secure Token Management
function getTokensPath() {
    return path.join(app.getPath('userData'), 'cloud_tokens.json');
}

function loadAllTokens() {
    const tokensPath = getTokensPath();
    if (!fs.existsSync(tokensPath)) return {};
    try {
        const raw = fs.readJsonSync(tokensPath);
        const decrypted = {};
        for (const provider in raw) {
            decrypted[provider] = {};
            for (const key in raw[provider]) {
                const encryptedHex = raw[provider][key];
                if (encryptedHex) {
                    try {
                        const encryptedBuffer = Buffer.from(encryptedHex, 'hex');
                        decrypted[provider][key] = safeStorage.isEncryptionAvailable()
                            ? safeStorage.decryptString(encryptedBuffer)
                            : encryptedBuffer.toString('utf8');
                    } catch(e) {
                        decrypted[provider][key] = '';
                    }
                }
            }
        }
        return decrypted;
    } catch(e) {
        return {};
    }
}

function saveTokens(provider, tokens) {
    const tokensPath = getTokensPath();
    const all = fs.existsSync(tokensPath) ? fs.readJsonSync(tokensPath) : {};
    all[provider] = {};
    for (const key in tokens) {
        const val = tokens[key];
        if (val) {
            const encryptedHex = safeStorage.isEncryptionAvailable()
                ? safeStorage.encryptString(val).toString('hex')
                : Buffer.from(val, 'utf8').toString('hex');
            all[provider][key] = encryptedHex;
        }
    }
    fs.writeJsonSync(tokensPath, all);
}

function deleteTokens(provider) {
    const tokensPath = getTokensPath();
    if (!fs.existsSync(tokensPath)) return;
    try {
        const all = fs.readJsonSync(tokensPath);
        delete all[provider];
        fs.writeJsonSync(tokensPath, all);
    } catch(e) {}
}

// Utility: Local OAuth Callback HTTP Server
let activeOauthServer = null;
function startOauthServer() {
    return new Promise((resolve, reject) => {
        if (activeOauthServer) {
            try { activeOauthServer.close(); } catch(e) {}
        }
        activeOauthServer = http.createServer((req, res) => {
            const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
            if (url.pathname === '/callback') {
                const code = url.searchParams.get('code');
                const error = url.searchParams.get('error');
                
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                if (code) {
                    res.end(`
                        <html>
                        <body style="font-family: sans-serif; background: #0c0a09; color: #f5f5f4; text-align: center; padding: 50px; display: flex; align-items: center; justify-content: center; height: calc(100vh - 100px); margin: 0;">
                            <div style="max-width: 400px; background: #1c1917; border: 1px solid #2e2a24; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);">
                                <h1 style="color: #10b981; margin-bottom: 20px; font-size: 28px;">✓ Connected</h1>
                                <p style="font-size: 15px; opacity: 0.8; margin-bottom: 30px; line-height: 1.5;">Sail Launcher has successfully linked with your account.</p>
                                <p style="font-size: 13px; opacity: 0.5;">You can close this tab and return to the launcher.</p>
                            </div>
                        </body>
                        </html>
                    `);
                    resolve(code);
                } else {
                    res.end(`
                        <html>
                        <body style="font-family: sans-serif; background: #0c0a09; color: #f5f5f4; text-align: center; padding: 50px; display: flex; align-items: center; justify-content: center; height: calc(100vh - 100px); margin: 0;">
                            <div style="max-width: 400px; background: #1c1917; border: 1px solid #7f1d1d; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);">
                                <h1 style="color: #ef4444; margin-bottom: 20px; font-size: 28px;">✗ Auth Failed</h1>
                                <p style="font-size: 15px; opacity: 0.8; margin-bottom: 30px; line-height: 1.5;">Error: ${error || 'Unknown authorization error.'}</p>
                                <p style="font-size: 13px; opacity: 0.5;">Please close this window and try again.</p>
                            </div>
                        </body>
                        </html>
                    `);
                    reject(new Error(error || 'Authorization failed.'));
                }
                setTimeout(() => {
                    if (activeOauthServer) {
                        activeOauthServer.close();
                        activeOauthServer = null;
                    }
                }, 1000);
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        activeOauthServer.on('error', (err) => {
            reject(err);
        });
        activeOauthServer.listen(REDIRECT_PORT);
    });
}

// Credentials Resolver (Custom vs Default)
function getCredentials(provider, customCreds = {}) {
    const creds = { ...DEFAULT_CREDS[provider] };
    if (customCreds && customCreds[provider]) {
        if (customCreds[provider].clientId) creds.clientId = customCreds[provider].clientId;
        if (customCreds[provider].clientSecret) creds.clientSecret = customCreds[provider].clientSecret;
    }
    return creds;
}

// --- PROVIDER IMPLEMENTATIONS ---

// 1. GOOGLE DRIVE
const googleDrive = {
    getAuthUrl(customCreds) {
        const creds = getCredentials('google', customCreds);
        return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${creds.clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.file email')}&access_type=offline&prompt=consent`;
    },
    async exchangeCode(code, customCreds) {
        const creds = getCredentials('google', customCreds);
        const bodyParams = `code=${code}&client_id=${creds.clientId}&client_secret=${creds.clientSecret}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&grant_type=authorization_code`;
        const res = await request('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }, bodyParams);
        
        let email = 'Google Account';
        try {
            const userRes = await request(`https://www.googleapis.com/oauth2/v3/userinfo?access_token=${res.body.access_token}`);
            if (userRes.body && userRes.body.email) email = userRes.body.email;
        } catch(e) {}

        const tokens = {
            access_token: res.body.access_token,
            refresh_token: res.body.refresh_token || '',
            email: email
        };
        saveTokens('google', tokens);
        return tokens;
    },
    async refreshAccessToken(customCreds) {
        const creds = getCredentials('google', customCreds);
        const tokens = loadAllTokens().google;
        if (!tokens || !tokens.refresh_token) throw new Error('No refresh token available');
        const bodyParams = `client_id=${creds.clientId}&client_secret=${creds.clientSecret}&refresh_token=${tokens.refresh_token}&grant_type=refresh_token`;
        const res = await request('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }, bodyParams);
        tokens.access_token = res.body.access_token;
        saveTokens('google', tokens);
        return res.body.access_token;
    },
    async executeWithRefresh(func, customCreds) {
        try {
            const tokens = loadAllTokens().google;
            if (!tokens || !tokens.access_token) throw new Error('Not linked to Google Drive');
            return await func(tokens.access_token);
        } catch(err) {
            if (err.message && (err.message.includes('401') || err.message.includes('invalid_grant'))) {
                const newAccessToken = await this.refreshAccessToken(customCreds);
                return await func(newAccessToken);
            }
            throw err;
        }
    },
    async getOrCreateSyncFolder(accessToken) {
        const query = encodeURIComponent("name = 'SailLauncherSaves' and mimeType = 'application/vnd.google-apps.folder' and trashed = false");
        const listRes = await request(`https://www.googleapis.com/drive/v3/files?q=${query}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (listRes.body.files && listRes.body.files.length > 0) {
            return listRes.body.files[0].id;
        }
        const createRes = await request('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        }, {
            name: 'SailLauncherSaves',
            mimeType: 'application/vnd.google-apps.folder'
        });
        return createRes.body.id;
    },
    async uploadFile(customCreds, gameName, localZipPath, maxVersions) {
        return await this.executeWithRefresh(async (accessToken) => {
            const parentId = await this.getOrCreateSyncFolder(accessToken);
            const safeName = gameName.replace(/[<>:"/\\|?*]+/g, '');
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const zipName = `${safeName}_save_${timestamp}.zip`;
            
            const fileMetadata = {
                name: zipName,
                parents: [parentId]
            };
            
            const boundary = '----SailLauncherBoundary' + crypto.randomBytes(8).toString('hex');
            const fileData = fs.readFileSync(localZipPath);
            
            const multipartBody = Buffer.concat([
                Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(fileMetadata)}\r\n`),
                Buffer.from(`--${boundary}\r\nContent-Type: application/zip\r\n\r\n`),
                fileData,
                Buffer.from(`\r\n--${boundary}--\r\n`)
            ]);

            await request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': `multipart/related; boundary=${boundary}`,
                    'Content-Length': multipartBody.length
                }
            }, multipartBody);

            if (maxVersions > 0) {
                try {
                    const query = encodeURIComponent(`name contains '${safeName}_save_' and '${parentId}' in parents and trashed = false`);
                    const listRes = await request(`https://www.googleapis.com/drive/v3/files?q=${query}&orderBy=name`, {
                        headers: { 'Authorization': `Bearer ${accessToken}` }
                    });
                    if (listRes.body.files && listRes.body.files.length > maxVersions) {
                        const toDelete = listRes.body.files.slice(0, listRes.body.files.length - maxVersions);
                        for (const file of toDelete) {
                            try {
                                await request(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
                                    method: 'DELETE',
                                    headers: { 'Authorization': `Bearer ${accessToken}` }
                                });
                            } catch(e) {}
                        }
                    }
                } catch(e) {}
            }
            return true;
        }, customCreds);
    },
    async listFiles(customCreds, gameName) {
        return await this.executeWithRefresh(async (accessToken) => {
            const parentId = await this.getOrCreateSyncFolder(accessToken);
            const safeName = gameName.replace(/[<>:"/\\|?*]+/g, '');
            const query = encodeURIComponent(`name contains '${safeName}_save_' and '${parentId}' in parents and trashed = false`);
            const listRes = await request(`https://www.googleapis.com/drive/v3/files?q=${query}&orderBy=name+desc`, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            if (!listRes.body.files) return [];
            return listRes.body.files.map(f => {
                const prefix = `${safeName}_save_`;
                let dateStr = f.name.replace(prefix, '').replace('.zip', '');
                let parsedDate = null;
                if (dateStr.length === 19) {
                    parsedDate = `${dateStr.slice(0, 4)}-${dateStr.slice(5, 7)}-${dateStr.slice(8, 10)} ${dateStr.slice(11, 13)}:${dateStr.slice(14, 16)}`;
                }
                return { filename: f.name, date: parsedDate || dateStr, id: f.id };
            });
        }, customCreds);
    },
    async downloadFile(customCreds, fileId, localZipPath) {
        return await this.executeWithRefresh(async (accessToken) => {
            return new Promise((resolve, reject) => {
                const file = fs.createWriteStream(localZipPath);
                https.get(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                }, (res) => {
                    if (res.statusCode === 200) {
                        res.pipe(file);
                        file.on('finish', () => {
                            file.close();
                            resolve(true);
                        });
                    } else {
                        reject(new Error(`Download status code: ${res.statusCode}`));
                    }
                }).on('error', (err) => {
                    fs.unlink(localZipPath, () => {});
                    reject(err);
                });
            });
        }, customCreds);
    }
};

// 2. MICROSOFT ONEDRIVE
const oneDrive = {
    getAuthUrl(customCreds) {
        const creds = getCredentials('onedrive', customCreds);
        return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${creds.clientId}&scope=${encodeURIComponent('files.readwrite offline_access User.Read')}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
    },
    async exchangeCode(code, customCreds) {
        const creds = getCredentials('onedrive', customCreds);
        const bodyParams = `client_id=${creds.clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code=${code}&grant_type=authorization_code`;
        const res = await request('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }, bodyParams);

        let email = 'OneDrive Account';
        try {
            const userRes = await request('https://graph.microsoft.com/v1.0/me', {
                headers: { 'Authorization': `Bearer ${res.body.access_token}` }
            });
            if (userRes.body && (userRes.body.userPrincipalName || userRes.body.mail)) {
                email = userRes.body.userPrincipalName || userRes.body.mail;
            }
        } catch(e) {}

        const tokens = {
            access_token: res.body.access_token,
            refresh_token: res.body.refresh_token || '',
            email: email
        };
        saveTokens('onedrive', tokens);
        return tokens;
    },
    async refreshAccessToken(customCreds) {
        const creds = getCredentials('onedrive', customCreds);
        const tokens = loadAllTokens().onedrive;
        if (!tokens || !tokens.refresh_token) throw new Error('No refresh token available');
        const bodyParams = `client_id=${creds.clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&refresh_token=${tokens.refresh_token}&grant_type=refresh_token`;
        const res = await request('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }, bodyParams);
        tokens.access_token = res.body.access_token;
        if (res.body.refresh_token) tokens.refresh_token = res.body.refresh_token;
        saveTokens('onedrive', tokens);
        return res.body.access_token;
    },
    async executeWithRefresh(func, customCreds) {
        try {
            const tokens = loadAllTokens().onedrive;
            if (!tokens || !tokens.access_token) throw new Error('Not linked to OneDrive');
            return await func(tokens.access_token);
        } catch(err) {
            if (err.message && (err.message.includes('401') || err.message.includes('TokenExpired'))) {
                const newAccessToken = await this.refreshAccessToken(customCreds);
                return await func(newAccessToken);
            }
            throw err;
        }
    },
    async uploadFile(customCreds, gameName, localZipPath, maxVersions) {
        return await this.executeWithRefresh(async (accessToken) => {
            const safeName = gameName.replace(/[<>:"/\\|?*]+/g, '');
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const zipName = `${safeName}_save_${timestamp}.zip`;
            const cloudPath = encodeURIComponent(`SailLauncherSaves/${zipName}`);

            const fileData = fs.readFileSync(localZipPath);
            await request(`https://graph.microsoft.com/v1.0/me/drive/root:/${cloudPath}:/content`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/zip'
                }
            }, fileData);

            if (maxVersions > 0) {
                try {
                    const listRes = await request(`https://graph.microsoft.com/v1.0/me/drive/root:/SailLauncherSaves:/children?$orderby=name`, {
                        headers: { 'Authorization': `Bearer ${accessToken}` }
                    });
                    if (listRes.body.value) {
                        const matching = listRes.body.value.filter(item => item.name.startsWith(`${safeName}_save_`) && item.name.endsWith('.zip'));
                        if (matching.length > maxVersions) {
                            const toDelete = matching.slice(0, matching.length - maxVersions);
                            for (const item of toDelete) {
                                try {
                                    await request(`https://graph.microsoft.com/v1.0/me/drive/items/${item.id}`, {
                                        method: 'DELETE',
                                        headers: { 'Authorization': `Bearer ${accessToken}` }
                                    });
                                } catch(e) {}
                            }
                        }
                    }
                } catch(e) {}
            }
            return true;
        }, customCreds);
    },
    async listFiles(customCreds, gameName) {
        return await this.executeWithRefresh(async (accessToken) => {
            try {
                const listRes = await request(`https://graph.microsoft.com/v1.0/me/drive/root:/SailLauncherSaves:/children?$orderby=name+desc`, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });
                if (!listRes.body.value) return [];
                const safeName = gameName.replace(/[<>:"/\\|?*]+/g, '');
                return listRes.body.value
                    .filter(item => item.name.startsWith(`${safeName}_save_`) && item.name.endsWith('.zip'))
                    .map(item => {
                        const prefix = `${safeName}_save_`;
                        let dateStr = item.name.replace(prefix, '').replace('.zip', '');
                        let parsedDate = null;
                        if (dateStr.length === 19) {
                            parsedDate = `${dateStr.slice(0, 4)}-${dateStr.slice(5, 7)}-${dateStr.slice(8, 10)} ${dateStr.slice(11, 13)}:${dateStr.slice(14, 16)}`;
                        }
                        return { filename: item.name, date: parsedDate || dateStr, id: item.id };
                    });
            } catch(e) {
                // If folder doesn't exist, OneDrive returns 404
                return [];
            }
        }, customCreds);
    },
    async downloadFile(customCreds, fileId, localZipPath) {
        return await this.executeWithRefresh(async (accessToken) => {
            return new Promise((resolve, reject) => {
                const file = fs.createWriteStream(localZipPath);
                https.get(`https://graph.microsoft.com/v1.0/me/drive/items/${fileId}/content`, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                }, (res) => {
                    if (res.statusCode === 302 && res.headers.location) {
                        // Microsoft redirect to download URL
                        https.get(res.headers.location, (redRes) => {
                            if (redRes.statusCode === 200) {
                                redRes.pipe(file);
                                file.on('finish', () => { file.close(); resolve(true); });
                            } else reject(new Error(`OneDrive download error: ${redRes.statusCode}`));
                        });
                    } else if (res.statusCode === 200) {
                        res.pipe(file);
                        file.on('finish', () => { file.close(); resolve(true); });
                    } else {
                        reject(new Error(`OneDrive download status: ${res.statusCode}`));
                    }
                }).on('error', (err) => {
                    fs.unlink(localZipPath, () => {});
                    reject(err);
                });
            });
        }, customCreds);
    }
};

// 3. DROPBOX
const dropbox = {
    getAuthUrl(customCreds) {
        const creds = getCredentials('dropbox', customCreds);
        return `https://www.dropbox.com/oauth2/authorize?client_id=${creds.clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&token_access_type=offline`;
    },
    async exchangeCode(code, customCreds) {
        const creds = getCredentials('dropbox', customCreds);
        const bodyParams = `code=${code}&client_id=${creds.clientId}&client_secret=${creds.clientSecret}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&grant_type=authorization_code`;
        const res = await request('https://api.dropboxapi.com/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }, bodyParams);

        let email = 'Dropbox Account';
        try {
            const userRes = await request('https://api.dropboxapi.com/2/users/get_current_account', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${res.body.access_token}`,
                    'Content-Type': 'application/json'
                }
            }, null);
            if (userRes.body && userRes.body.email) email = userRes.body.email;
        } catch(e) {}

        const tokens = {
            access_token: res.body.access_token,
            refresh_token: res.body.refresh_token || '',
            email: email
        };
        saveTokens('dropbox', tokens);
        return tokens;
    },
    async refreshAccessToken(customCreds) {
        const creds = getCredentials('dropbox', customCreds);
        const tokens = loadAllTokens().dropbox;
        if (!tokens || !tokens.refresh_token) throw new Error('No refresh token available');
        const bodyParams = `client_id=${creds.clientId}&client_secret=${creds.clientSecret}&refresh_token=${tokens.refresh_token}&grant_type=refresh_token`;
        const res = await request('https://api.dropboxapi.com/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }, bodyParams);
        tokens.access_token = res.body.access_token;
        saveTokens('dropbox', tokens);
        return res.body.access_token;
    },
    async executeWithRefresh(func, customCreds) {
        try {
            const tokens = loadAllTokens().dropbox;
            if (!tokens || !tokens.access_token) throw new Error('Not linked to Dropbox');
            return await func(tokens.access_token);
        } catch(err) {
            if (err.message && (err.message.includes('401') || err.message.includes('expired_access_token'))) {
                const newAccessToken = await this.refreshAccessToken(customCreds);
                return await func(newAccessToken);
            }
            throw err;
        }
    },
    async uploadFile(customCreds, gameName, localZipPath, maxVersions) {
        return await this.executeWithRefresh(async (accessToken) => {
            const safeName = gameName.replace(/[<>:"/\\|?*]+/g, '');
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const zipName = `${safeName}_save_${timestamp}.zip`;
            
            const fileArg = {
                path: `/SailLauncherSaves/${zipName}`,
                mode: 'add',
                autorename: false,
                mute: true
            };
            const fileData = fs.readFileSync(localZipPath);

            await request('https://content.dropboxapi.com/2/files/upload', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Dropbox-API-Arg': JSON.stringify(fileArg),
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': fileData.length
                }
            }, fileData);

            if (maxVersions > 0) {
                try {
                    const listRes = await request('https://api.dropboxapi.com/2/files/list_folder', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${accessToken}`,
                            'Content-Type': 'application/json'
                        }
                    }, { path: '/SailLauncherSaves' });
                    
                    if (listRes.body.entries) {
                        const matching = listRes.body.entries
                            .filter(f => f.name.startsWith(`${safeName}_save_`) && f.name.endsWith('.zip'))
                            .sort((a,b) => a.name.localeCompare(b.name));
                        if (matching.length > maxVersions) {
                            const toDelete = matching.slice(0, matching.length - maxVersions);
                            for (const f of toDelete) {
                                try {
                                    await request('https://api.dropboxapi.com/2/files/delete_v2', {
                                        method: 'POST',
                                        headers: {
                                            'Authorization': `Bearer ${accessToken}`,
                                            'Content-Type': 'application/json'
                                        }
                                    }, { path: f.path_lower });
                                } catch(e) {}
                            }
                        }
                    }
                } catch(e) {}
            }
            return true;
        }, customCreds);
    },
    async listFiles(customCreds, gameName) {
        return await this.executeWithRefresh(async (accessToken) => {
            try {
                const listRes = await request('https://api.dropboxapi.com/2/files/list_folder', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }, { path: '/SailLauncherSaves' });
                
                if (!listRes.body.entries) return [];
                const safeName = gameName.replace(/[<>:"/\\|?*]+/g, '');
                return listRes.body.entries
                    .filter(f => f.name.startsWith(`${safeName}_save_`) && f.name.endsWith('.zip'))
                    .map(f => {
                        const prefix = `${safeName}_save_`;
                        let dateStr = f.name.replace(prefix, '').replace('.zip', '');
                        let parsedDate = null;
                        if (dateStr.length === 19) {
                            parsedDate = `${dateStr.slice(0, 4)}-${dateStr.slice(5, 7)}-${dateStr.slice(8, 10)} ${dateStr.slice(11, 13)}:${dateStr.slice(14, 16)}`;
                        }
                        return { filename: f.name, date: parsedDate || dateStr, id: f.path_lower };
                    })
                    .sort((a, b) => b.filename.localeCompare(a.filename)); // newest first
            } catch(e) {
                return [];
            }
        }, customCreds);
    },
    async downloadFile(customCreds, pathLower, localZipPath) {
        return await this.executeWithRefresh(async (accessToken) => {
            return new Promise((resolve, reject) => {
                const file = fs.createWriteStream(localZipPath);
                https.get('https://content.dropboxapi.com/2/files/download', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Dropbox-API-Arg': JSON.stringify({ path: pathLower })
                    }
                }, (res) => {
                    if (res.statusCode === 200) {
                        res.pipe(file);
                        file.on('finish', () => { file.close(); resolve(true); });
                    } else reject(new Error(`Dropbox download error: ${res.statusCode}`));
                }).on('error', (err) => {
                    fs.unlink(localZipPath, () => {});
                    reject(err);
                });
            });
        }, customCreds);
    }
};

// 4. MEDIAFIRE (Experimental HTTP session client)
const mediaFire = {
    async connect(email, password, appId, apiKey) {
        // Build SHA1 signature
        const sigString = email + password + appId + apiKey;
        const signature = crypto.createHash('sha1').update(sigString).digest('hex');
        
        const url = `https://www.mediafire.com/api/1.4/user/get_session_token.php?email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}&application_id=${appId}&signature=${signature}&response_format=json`;
        const res = await request(url);
        
        if (res.body.response && res.body.response.session_token) {
            const tokens = {
                session_token: res.body.response.session_token,
                email: email,
                app_id: appId,
                api_key: apiKey
            };
            saveTokens('mediafire', tokens);
            return tokens;
        } else {
            const errorMsg = res.body.response?.message || 'Mediafire login failed';
            throw new Error(errorMsg);
        }
    },
    async uploadFile(gameName, localZipPath) {
        const tokens = loadAllTokens().mediafire;
        if (!tokens || !tokens.session_token) throw new Error('Mediafire account not connected');
        
        const fileData = fs.readFileSync(localZipPath);
        const safeName = gameName.replace(/[<>:"/\\|?*]+/g, '');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const zipName = `${safeName}_save_${timestamp}.zip`;

        // Upload endpoint (Requires headers for Mediafire upload api)
        const url = `https://www.mediafire.com/api/1.4/upload/simple.php?session_token=${tokens.session_token}&response_format=json`;
        await request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-Filename': zipName,
                'X-Filesize': fileData.length
            }
        }, fileData);
        return true;
    },
    async listFiles(gameName) {
        const tokens = loadAllTokens().mediafire;
        if (!tokens || !tokens.session_token) return [];
        const safeName = gameName.replace(/[<>:"/\\|?*]+/g, '');
        
        // List files in root directory
        const url = `https://www.mediafire.com/api/1.4/folder/get_content.php?session_token=${tokens.session_token}&content_type=files&response_format=json`;
        const res = await request(url);
        if (!res.body.response || !res.body.response.folder_content || !res.body.response.folder_content.files) {
            return [];
        }
        
        return res.body.response.folder_content.files
            .filter(f => f.filename.startsWith(`${safeName}_save_`) && f.filename.endsWith('.zip'))
            .map(f => {
                const prefix = `${safeName}_save_`;
                let dateStr = f.filename.replace(prefix, '').replace('.zip', '');
                let parsedDate = null;
                if (dateStr.length === 19) {
                    parsedDate = `${dateStr.slice(0, 4)}-${dateStr.slice(5, 7)}-${dateStr.slice(8, 10)} ${dateStr.slice(11, 13)}:${dateStr.slice(14, 16)}`;
                }
                return { filename: f.filename, date: parsedDate || dateStr, id: f.quickkey };
            })
            .sort((a, b) => b.filename.localeCompare(a.filename));
    },
    async downloadFile(quickKey, localZipPath) {
        const tokens = loadAllTokens().mediafire;
        if (!tokens || !tokens.session_token) throw new Error('Mediafire account not connected');
        
        // Get Direct Link
        const linkUrl = `https://www.mediafire.com/api/1.4/file/get_links.php?session_token=${tokens.session_token}&quick_key=${quickKey}&response_format=json`;
        const linkRes = await request(linkUrl);
        if (!linkRes.body.response || !linkRes.body.response.links || !linkRes.body.response.links[0]) {
            throw new Error('Could not get download link from Mediafire');
        }
        const directLink = linkRes.body.response.links[0].direct_download || linkRes.body.response.links[0].normal_download;
        
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(localZipPath);
            https.get(directLink, (res) => {
                if (res.statusCode === 200) {
                    res.pipe(file);
                    file.on('finish', () => { file.close(); resolve(true); });
                } else reject(new Error(`Mediafire download error: ${res.statusCode}`));
            }).on('error', (err) => {
                fs.unlink(localZipPath, () => {});
                reject(err);
            });
        });
    }
};

// EXPORTS
module.exports = {
    startOauthServer,
    loadAllTokens,
    saveTokens,
    deleteTokens,
    googleDrive,
    oneDrive,
    dropbox,
    mediaFire
};
