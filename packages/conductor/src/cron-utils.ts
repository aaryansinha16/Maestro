// Tiny helper for the dashboard /api/schedule endpoint: given a cron
// expression and a timezone, compute the next time the expression
// fires. We use a minimal home-grown evaluator rather than a third-party
// dep because the only consumer is the dashboard's "next run" column —
// it's informational, not load-bearing.
//
// The evaluator handles:
//   - five-field expressions (minute hour day-of-month month day-of-week)
//   - `*`, `*/N`, comma lists, hyphen ranges, plain numbers
//
// It does NOT handle: weird DOW/DOM logic (e.g. POSIX cron "OR"
// semantics for DOW vs DOM is approximated as "match either"),
// `?`, name-based DOW/month, special strings (@daily, @hourly).
// Those are unusual enough that we'd rather return null and let the
// dashboard show "—" than emit a wrong value.

export function computeNextCronRun(
  expr: string,
  timezone = 'UTC',
  from: Date = new Date(),
): string | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null

  // Special-case: assume timezone-naive UTC when MAESTRO_TZ is non-UTC,
  // we cannot fully model arbitrary tz offsets in <100 lines. Surface
  // the best-effort result; the actual scheduling is correct (node-cron
  // handles the timezone) — only this informational hint is approximate.
  void timezone

  const minute = parseField(fields[0]!, 0, 59)
  const hour = parseField(fields[1]!, 0, 23)
  const dom = parseField(fields[2]!, 1, 31)
  const month = parseField(fields[3]!, 1, 12)
  const dow = parseField(fields[4]!, 0, 6)
  if (!minute || !hour || !dom || !month || !dow) return null

  // Walk forward minute-by-minute up to a year; cron expressions that
  // never fire would be a config bug.
  const probe = new Date(from.getTime())
  probe.setUTCSeconds(0, 0)
  probe.setUTCMinutes(probe.getUTCMinutes() + 1)
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (
      minute.has(probe.getUTCMinutes()) &&
      hour.has(probe.getUTCHours()) &&
      month.has(probe.getUTCMonth() + 1) &&
      (dom.has(probe.getUTCDate()) || dow.has(probe.getUTCDay()))
    ) {
      return probe.toISOString()
    }
    probe.setUTCMinutes(probe.getUTCMinutes() + 1)
  }
  return null
}

function parseField(field: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    if (part === '*') {
      for (let v = lo; v <= hi; v++) out.add(v)
      continue
    }
    const stepMatch = /^(.*)\/(\d+)$/.exec(part)
    let base = stepMatch ? stepMatch[1]! : part
    const step = stepMatch ? Number(stepMatch[2]) : 1
    if (!Number.isFinite(step) || step <= 0) return null
    if (base === '' || base === '*') base = `${lo}-${hi}`
    let start: number
    let end: number
    if (base.includes('-')) {
      const [s, e] = base.split('-')
      start = Number(s)
      end = Number(e)
    } else {
      start = Number(base)
      end = start
    }
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < lo ||
      end > hi ||
      start > end
    ) {
      return null
    }
    for (let v = start; v <= end; v += step) out.add(v)
  }
  return out.size > 0 ? out : null
}
