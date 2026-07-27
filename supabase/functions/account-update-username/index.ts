import { adminClient, requireUser } from '../_shared/supabase.ts'
import { json, options } from '../_shared/http.ts'
import { requireFreshEmailVerification } from '../_shared/verification.ts'

Deno.serve(async (req) => {
  const preflight = options(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { user } = await requireUser(req)
    requireFreshEmailVerification(req)
    const body = await req.json()
    const username = String(body.username ?? '').trim()
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
      return json({ error: 'Username must be 3-32 characters using letters, numbers, dots, dashes, or underscores.' }, 400)
    }

    const admin = adminClient()
    const { data: existing, error: lookupError } = await admin
      .from('profiles')
      .select('id')
      .ilike('username', username)
      .neq('id', user.id)
      .maybeSingle()
    if (lookupError) throw lookupError
    if (existing) return json({ error: 'That username is already in use.' }, 409)

    const { data: profile, error } = await admin
      .from('profiles')
      .update({ username })
      .eq('id', user.id)
      .select('id,username,avatar_url,created_at')
      .single()
    if (error) throw error

    await admin.auth.admin.updateUserById(user.id, {
      user_metadata: { ...(user.user_metadata ?? {}), username },
    })
    return json({ profile })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update username.'
    const unauthorized = message === 'Unauthorized' || message.toLowerCase().includes('verification')
    return json({ error: message }, unauthorized ? 401 : 500)
  }
})
