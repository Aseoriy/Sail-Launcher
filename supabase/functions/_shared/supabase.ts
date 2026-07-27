import { createClient } from 'npm:@supabase/supabase-js@2.109.0'

function firstKey(names: string[]) {
  for (const name of names) {
    const raw = Deno.env.get(name)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw)
      return String(parsed.default ?? Object.values(parsed)[0] ?? '')
    } catch {
      return raw
    }
  }
  return ''
}

export const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
export const publishableKey = firstKey([
  'SUPABASE_PUBLISHABLE_KEYS',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_ANON_KEY',
])
export const secretKey = firstKey([
  'SUPABASE_SECRET_KEYS',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
])

export function adminClient() {
  return createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export function userClient(req: Request) {
  return createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export async function requireUser(req: Request) {
  const client = userClient(req)
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data, error } = await client.auth.getUser(token)
  if (error || !data.user) throw new Error('Unauthorized')
  return { client, user: data.user }
}
