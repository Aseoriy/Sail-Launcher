import { adminClient, requireUser } from '../_shared/supabase.ts'
import { json, options } from '../_shared/http.ts'
import { requireFreshEmailVerification } from '../_shared/verification.ts'

async function removeUserObjects(admin: ReturnType<typeof adminClient>, bucket: string, userId: string) {
  while (true) {
    const { data, error } = await admin.storage.from(bucket).list(userId, {
      limit: 100,
      sortBy: { column: 'name', order: 'asc' },
    })
    if (error) throw error
    const names = (data ?? []).filter(item => item.id).map(item => `${userId}/${item.name}`)
    if (names.length) {
      const { error: removeError } = await admin.storage.from(bucket).remove(names)
      if (removeError) throw removeError
    }
    if ((data ?? []).length < 100) break
  }
}

Deno.serve(async (req) => {
  const preflight = options(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { user } = await requireUser(req)
    requireFreshEmailVerification(req)
    const body = await req.json()
    if (body.confirm !== 'DELETE') return json({ error: 'Type DELETE to confirm account deletion.' }, 400)

    const admin = adminClient()
    const purgeResponse = await fetch('https://storage-api.sailhub.fyi/v1/internal/purge-user', {
      method: 'POST',
      headers: {
        Authorization: req.headers.get('Authorization') ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: user.id }),
    })
    if (!purgeResponse.ok) {
      throw new Error('Sail Cloud data could not be purged. Your account was not deleted; please try again.')
    }

    const { data: connections, error: connectionError } = await admin
      .from('cloud_connections')
      .select('id')
      .eq('user_id', user.id)
    if (connectionError) throw connectionError
    for (const connection of connections ?? []) {
      const { error } = await admin.rpc('delete_cloud_connection_secret', {
        p_user_id: user.id,
        p_connection_id: connection.id,
      })
      if (error) throw error
    }

    for (const bucket of ['avatars', 'files', 'previews']) {
      await removeUserObjects(admin, bucket, user.id)
    }

    const { error } = await admin.auth.admin.deleteUser(user.id)
    if (error) throw error
    return json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to delete account.'
    const unauthorized = message === 'Unauthorized' || message.toLowerCase().includes('verification')
    return json({ error: message }, unauthorized ? 401 : 500)
  }
})
