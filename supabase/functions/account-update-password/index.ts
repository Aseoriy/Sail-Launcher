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
    const password = String(body.password ?? '')
    if (password.length < 8) {
      return json({ error: 'Password must be at least 8 characters.' }, 400)
    }
    if (password.length > 128) {
      return json({ error: 'Password must be 128 characters or fewer.' }, 400)
    }

    const { error } = await adminClient().auth.admin.updateUserById(user.id, { password })
    if (error) throw error
    return json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update password.'
    const unauthorized = message === 'Unauthorized' || message.toLowerCase().includes('verification')
    return json({ error: message }, unauthorized ? 401 : 500)
  }
})
