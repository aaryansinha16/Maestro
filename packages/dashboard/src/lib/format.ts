// Tiny presentation helpers. Kept out of components so they can be reused
// and tested independently if/when we add tests for the dashboard.

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function formatDuration(start: string, end: string | null | undefined): string {
  if (!end) return 'in progress'
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (Number.isNaN(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function statusLabel(status: string): string {
  return status.replace(/-/g, ' ')
}

export function gateTag(status: string): string {
  return status === 'passed' ? '✓' : status === 'failed' ? '✗' : '∼'
}
