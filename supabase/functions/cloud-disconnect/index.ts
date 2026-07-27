import { adminClient, requireUser } from '../_shared/supabase.ts'
import { json, options } from '../_shared/http.ts'

Deno.serve(async (req) => {
  const preflight = options(req)
  if (preflight) return preflight
  try {
    const { user } = await requireUser(req)
    const body = await req.json()
    const provider = String(body.provider ?? '')
    const admin = adminClient()
    const { data: connection } = await admin
      .from('cloud_connections')
      .select('id')
      .eq('user_id', user.id)
      .eq('provider', provider)
      .maybeSingle()
    if (connection) {
      const { error } = await admin.rpc('delete_cloud_connection_secret', {
        p_user_id: user.id,
        p_connection_id: connection.id,
      })
      if (error) throw error
    }
    return json({ success: true })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Unable to disconnect provider.' }, 401)
  }
})
