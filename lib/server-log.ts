import 'server-only'

export function logOperationalError(event: string, requestId: string, error: unknown) {
  const detail = error instanceof Error ? error.message.slice(0, 160) : 'unknown error'
  console.error(JSON.stringify({ level: 'error', event, requestId, detail }))
}
