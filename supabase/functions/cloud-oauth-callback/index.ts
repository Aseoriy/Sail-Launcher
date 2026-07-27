import { adminClient, supabaseUrl } from '../_shared/supabase.ts'

const launcherRedirect = 'sail-launcher://cloud-callback'
const callbackUrl = `${supabaseUrl}/functions/v1/cloud-oauth-callback`

function redirect(params: Record<string, string>) {
  const url = new URL(launcherRedirect)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return Response.redirect(url.toString(), 302)
}

async function exchange(provider: string, code: string) {
  if (provider === 'google') {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
        client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
        redirect_uri: callbackUrl,
        grant_type: 'authorization_code',
      }),
    })
    const token = await response.json()
    if (!response.ok) throw new Error('Google authorization failed.')
    const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    }).then(result => result.json())
    return { token, label: info.email ?? 'Google Drive' }
  }

  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: Deno.env.get('DROPBOX_CLIENT_ID') ?? '',
      client_secret: Deno.env.get('DROPBOX_CLIENT_SECRET') ?? '',
      redirect_uri: callbackUrl,
      grant_type: 'authorization_code',
    }),
  })
  const token = await response.json()
  if (!response.ok) throw new Error('Dropbox authorization failed.')
  const info = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
    body: 'null',
  }).then(result => result.json())
  return { token, label: info.email ?? info.name?.display_name ?? 'Dropbox' }
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url)
    const state = url.searchParams.get('state') ?? ''
    const code = url.searchParams.get('code') ?? ''
    if (!state || !code || url.searchParams.get('error')) return redirect({ success: '0', error: 'Authorization cancelled.' })

    const admin = adminClient()
    const { data: pending } = await admin
      .from('oauth_states')
      .select('*')
      .eq('id', state)
      .eq('consumed', false)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    if (!pending) return redirect({ success: '0', error: 'Authorization request expired.' })

    const result = await exchange(pending.provider, code)
    const expiresAt = Date.now() + Number(result.token.expires_in ?? 3600) * 1000
    const secret = {
      access_token: result.token.access_token,
      refresh_token: result.token.refresh_token,
      expires_at: expiresAt,
      token_type: result.token.token_type ?? 'Bearer',
    }
    const { error } = await admin.rpc('store_cloud_connection_secret', {
      p_user_id: pending.user_id,
      p_provider: pending.provider,
      p_label: result.label,
      p_secret: secret,
      p_metadata: {},
    })
    if (error) throw error
    await admin.from('oauth_states').update({ consumed: true }).eq('id', state)
    return redirect({ success: '1', provider: pending.provider })
  } catch {
    return redirect({ success: '0', error: 'Cloud authorization failed.' })
  }
})
