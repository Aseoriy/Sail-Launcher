function decodePayload(token: string) {
  const payload = token.split('.')[1]
  if (!payload) throw new Error('Email verification is required.')
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return JSON.parse(atob(padded))
}

export function requireFreshEmailVerification(req: Request, maxAgeSeconds = 15 * 60) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const claims = decodePayload(token)
  const now = Math.floor(Date.now() / 1000)
  const verified = Array.isArray(claims.amr) && claims.amr.some((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return false
    const method = String((entry as Record<string, unknown>).method ?? '').toLowerCase()
    const timestamp = Number((entry as Record<string, unknown>).timestamp ?? 0)
    return method === 'otp' && timestamp > 0 && now - timestamp <= maxAgeSeconds
  })
  if (!verified) {
    throw new Error('Enter the 8-digit verification code sent to your account email, then try again.')
  }
}
