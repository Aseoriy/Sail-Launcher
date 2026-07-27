import { createClient } from 'npm:@supabase/supabase-js@2.109.0'
import { adminClient, publishableKey, supabaseUrl } from '../_shared/supabase.ts'
import { json, options } from '../_shared/http.ts'

Deno.serve(async (req) => {
  const preflight = options(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const body = await req.json()
    const identifier = String(body.identifier ?? '').trim()
    const password = String(body.password ?? '')
    if (!identifier || !password || identifier.length > 320 || password.length > 1024) {
      return json({ error: 'Invalid email, username, or password.' }, 400)
    }

    let email = identifier
    if (!identifier.includes('@')) {
      const admin = adminClient()
      const { data: profile } = await admin
        .from('profiles')
        .select('id')
        .ilike('username', identifier)
        .maybeSingle()
      if (!profile) return json({ error: 'Invalid email, username, or password.' }, 401)
      const { data } = await admin.auth.admin.getUserById(profile.id)
      email = data.user?.email ?? ''
    }

    const client = createClient(supabaseUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data, error } = await client.auth.signInWithPassword({ email, password })
    if (error || !data.session) return json({ error: 'Invalid email, username, or password.' }, 401)
    return json({
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    })
  } catch {
    return json({ error: 'Unable to sign in right now.' }, 500)
  }
})
