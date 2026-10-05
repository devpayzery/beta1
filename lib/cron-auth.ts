export type CronAuthResult = { ok: true } | { ok: false; status: 401 | 503; error: 'CRON_SECRET is not configured' | 'unauthorized' }

export function authorizeCronRequest(request: Request, configuredSecret: string | undefined): CronAuthResult {
  if (!configuredSecret) return { ok: false, status: 503, error: 'CRON_SECRET is not configured' }
  if (request.headers.get('authorization') !== `Bearer ${configuredSecret}`) return { ok: false, status: 401, error: 'unauthorized' }
  return { ok: true }
}

export function getCronAuthResponse(result: Exclude<CronAuthResult, { ok: true }>, requestId: string) {
  return Response.json({ error: result.error, requestId }, { status: result.status })
}

export function isCronAuthorized(request: Request, configuredSecret: string | undefined) {
  return authorizeCronRequest(request, configuredSecret).ok
}

export const __cronAuthTestOnly = { authorizeCronRequest }

// The deployed contract operation must never be reached before authorizeCronRequest succeeds.
