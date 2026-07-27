import { HttpError } from './validation.js';

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { message: text }; }
}

export async function authenticate(request, env) {
  const authorization = request.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S+/i.test(authorization)) throw new HttpError(401, 'Sign in to your Sail account.');
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: authorization,
      apikey: env.SUPABASE_PUBLISHABLE_KEY
    }
  });
  const body = await readJson(response);
  if (!response.ok || !body?.id) throw new HttpError(401, 'Your Sail session is invalid or expired.');
  return { id: body.id, email: body.email || '', authorization };
}

export async function rpc(env, name, args) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  const body = await readJson(response);
  if (!response.ok) {
    const message = body?.message || body?.error || `Database request failed (${response.status}).`;
    if (message.includes('REVISION_CONFLICT')) throw new HttpError(409, 'This cloud item changed on another device.', 'REVISION_CONFLICT');
    if (message.includes('ACCOUNT_QUOTA_EXCEEDED')) throw new HttpError(413, 'Your Sail Cloud storage quota is full.', 'ACCOUNT_QUOTA_EXCEEDED');
    if (message.includes('NOT_FOUND')) throw new HttpError(404, message.replaceAll('_', ' ').toLowerCase());
    throw new HttpError(400, message);
  }
  return body;
}

export async function selectRows(env, table, query) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
    }
  });
  const body = await readJson(response);
  if (!response.ok) throw new HttpError(500, body?.message || 'Unable to read storage metadata.');
  return body || [];
}

export async function serviceWrite(env, table, { method = 'POST', query = '', body, prefer = 'return=representation' }) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}${query ? `?${query}` : ''}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await readJson(response);
  if (!response.ok) throw new HttpError(500, result?.message || `Unable to update ${table}.`);
  return result;
}
