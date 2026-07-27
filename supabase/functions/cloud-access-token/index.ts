import { adminClient, requireUser } from '../_shared/supabase.ts'
import { json, options } from '../_shared/http.ts'

async function refresh(provider: string, secret: Record<string, unknown>) {
  if (Number(secret.expires_at ?? 0) > Date.now() + 60_000) return secret
  const refreshToken = String(secret.refresh_token ?? '')
  if (!refreshToken) throw new Error('Cloud connection must be reauthorized.')

  const endpoint = provider === 'google'
    ? 'https://oauth2.googleapis.com/token'
    : 'https://api.dropboxapi.com/oauth2/token'
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    client_id: Deno.env.get(provider === 'google' ? 'GOOGLE_CLIENT_ID' : 'DROPBOX_CLIENT_ID') ?? '',
    client_secret: Deno.env.get(provider === 'google' ? 'GOOGLE_CLIENT_SECRET' : 'DROPBOX_CLIENT_SECRET') ?? '',
  })
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const token = await response.json()
  if (!response.ok) throw new Error('Cloud connection expired or was revoked.')
  return {
    ...secret,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? refreshToken,
    expires_at: Date.now() + Number(token.expires_in ?? 3600) * 1000,
  }
}

Deno.serve(async (req) => {
  const preflight = options(req)
  if (preflight) return preflight
  try {
    const { user } = await requireUser(req)
    const body = await req.json()
    const provider = String(body.provider ?? '')
    if (!['google', 'dropbox'].includes(provider)) return json({ error: 'Provider uses local credentials.' }, 400)
    const admin = adminClient()
    const { data: connection } = await admin
      .from('cloud_connections')
      .select('id,provider,provider_account_label,metadata')
      .eq('user_id', user.id)
      .eq('provider', provider)
      .maybeSingle()
    if (!connection) return json({ error: 'Cloud provider is not connected.' }, 404)
    const { data, error } = await admin.rpc('read_cloud_connection_secret', {
      p_user_id: user.id,
      p_connection_id: connection.id,
    })
    if (error || !data) throw error ?? new Error('Cloud credential is unavailable.')
    const secret = await refresh(provider, data)
    if (secret.access_token !== data.access_token) {
      await admin.rpc('store_cloud_connection_secret', {
        p_user_id: user.id,
        p_provider: provider,
        p_label: connection.provider_account_label,
        p_secret: secret,
        p_metadata: connection.metadata ?? {},
      })
    }
    return json({ access_token: secret.access_token, expires_at: secret.expires_at })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Unable to access cloud provider.' }, 401)
  }
})
