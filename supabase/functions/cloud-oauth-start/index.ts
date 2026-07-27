import { adminClient, requireUser, supabaseUrl } from '../_shared/supabase.ts'
import { json, options } from '../_shared/http.ts'

const callbackUrl = `${supabaseUrl}/functions/v1/cloud-oauth-callback`

function providerConfig(provider: string) {
  if (provider === 'google') {
    return {
      clientId: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      scope: 'https://www.googleapis.com/auth/drive.file email openid',
      extra: { access_type: 'offline', prompt: 'consent' },
    }
  }
  if (provider === 'dropbox') {
    return {
      clientId: Deno.env.get('DROPBOX_CLIENT_ID') ?? '',
      authUrl: 'https://www.dropbox.com/oauth2/authorize',
      scope: 'account_info.read files.content.read files.content.write files.metadata.read',
      extra: { token_access_type: 'offline' },
    }
  }
  return null
}

Deno.serve(async (req) => {
  const preflight = options(req)
  if (preflight) return preflight
  try {
    const { user } = await requireUser(req)
    const body = await req.json()
    const provider = String(body.provider ?? '')
    const config = providerConfig(provider)
    if (!config || !config.clientId) {
      return json({ error: provider === 'onedrive' ? 'OneDrive requires a custom local app.' : 'Provider is not configured.' }, 400)
    }

    const state = crypto.randomUUID()
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state))
    const nonceHash = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
    const admin = adminClient()
    await admin
      .from('oauth_states')
      .delete()
      .eq('user_id', user.id)
      .lt('expires_at', new Date().toISOString())
    const { error } = await admin.from('oauth_states').insert({
      id: state,
      user_id: user.id,
      provider,
      nonce_hash: nonceHash,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    if (error) throw error

    const url = new URL(config.authUrl)
    url.searchParams.set('client_id', config.clientId)
    url.searchParams.set('redirect_uri', callbackUrl)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', state)
    url.searchParams.set('scope', config.scope)
    for (const [key, value] of Object.entries(config.extra)) url.searchParams.set(key, value)
    return json({ url: url.toString() })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Unable to start authorization.' }, 401)
  }
})
