import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ListScheduleResponse, ScheduleEntry } from '@maestro/api'
import { useApi } from '../hooks/useApi'
import { formatDateTime } from '../lib/format'

const SCHEDULE_PRESETS: Array<{ label: string; expr: string }> = [
  { label: 'every 6 hours', expr: '0 */6 * * *' },
  { label: 'every 4 hours', expr: '0 */4 * * *' },
  { label: 'twice daily (08:00 and 20:00)', expr: '0 8,20 * * *' },
  { label: 'morning only (08:00)', expr: '0 8 * * *' },
  { label: 'weekday mornings', expr: '0 8 * * 1-5' },
  { label: 'custom — edit the field', expr: '' },
]

const ALL_WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const

export function Schedule() {
  const api = useApi()
  const [data, setData] = useState<ListScheduleResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [savingSlug, setSavingSlug] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void api
      .get<ListScheduleResponse>('/api/schedule')
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'unknown'))
  }, [api])

  useEffect(() => {
    refresh()
  }, [refresh])

  const toggle = async (entry: ScheduleEntry, enabled: boolean) => {
    setSavingSlug(entry.slug)
    try {
      const path = enabled ? 'enable' : 'disable'
      await api.post(`/api/projects/${encodeURIComponent(entry.slug)}/scheduling/${path}`)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown')
    } finally {
      setSavingSlug(null)
    }
  }

  const updateSchedule = async (entry: ScheduleEntry, body: Record<string, unknown>) => {
    setSavingSlug(entry.slug)
    try {
      await api.post(`/api/projects/${encodeURIComponent(entry.slug)}/schedule`, body)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown')
    } finally {
      setSavingSlug(null)
    }
  }

  return (
    <section className="mx-auto max-w-6xl">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-[0.2em] text-amber-500">Phase 2</p>
        <h2 className="mt-1 text-2xl font-semibold text-white">Schedule</h2>
        <p className="mt-1 text-sm text-navy-300">
          One row per registered project. Scheduling is opt-in — toggle a project on once
          manual sessions prove it's healthy.
        </p>
      </header>

      {error ? (
        <div className="panel mb-4 border-danger/40 bg-danger/10 px-5 py-4 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {!data ? (
        <div className="panel h-32 animate-pulse" />
      ) : data.entries.length === 0 ? (
        <div className="panel px-6 py-12 text-center">
          <h3 className="text-lg font-semibold text-white">No projects registered</h3>
          <p className="mt-2 text-sm text-navy-300">
            Add one with{' '}
            <code className="rounded bg-navy-950/70 px-2 py-0.5 text-amber-200">
              maestro add &lt;repo-url&gt;
            </code>
            . Scheduling is off by default for new projects.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {data.entries.map((e) => (
            <article key={e.slug} className="panel px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <Link
                    to={`/projects/${e.slug}`}
                    className="font-mono text-sm text-navy-100 hover:underline"
                  >
                    {e.slug}
                  </Link>
                  {e.autoPausedAt ? (
                    <span className="pill ml-3 border-amber-700/60 bg-amber-900/30 text-amber-300">
                      auto-paused
                    </span>
                  ) : null}
                </div>
                <label className="flex items-center gap-2 text-sm text-navy-200">
                  <span>scheduling</span>
                  <input
                    type="checkbox"
                    checked={e.scheduledEnabled}
                    disabled={savingSlug === e.slug}
                    onChange={(ev) => void toggle(e, ev.target.checked)}
                  />
                </label>
              </div>
              <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-navy-400">Schedule</dt>
                  <dd>
                    <select
                      className="bg-navy-950 text-navy-100"
                      value={e.schedule}
                      onChange={(ev) => {
                        const v = ev.target.value
                        if (v === '') return
                        void updateSchedule(e, { schedule: v })
                      }}
                    >
                      {SCHEDULE_PRESETS.map((p) => (
                        <option key={p.expr} value={p.expr || e.schedule}>
                          {p.label}
                        </option>
                      ))}
                      <option value={e.schedule}>{e.schedule}</option>
                    </select>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-navy-400">Skip days</dt>
                  <dd className="flex flex-wrap gap-1 text-xs">
                    {ALL_WEEKDAYS.map((d) => {
                      const active = e.skipDays.includes(d)
                      return (
                        <button
                          key={d}
                          type="button"
                          onClick={() =>
                            updateSchedule(e, {
                              skipDays: active
                                ? e.skipDays.filter((x) => x !== d)
                                : [...e.skipDays, d],
                            })
                          }
                          className={`rounded px-1.5 py-0.5 ${
                            active
                              ? 'border border-amber-700/60 bg-amber-900/40 text-amber-200'
                              : 'border border-navy-700 bg-navy-900 text-navy-400 hover:border-navy-500'
                          }`}
                        >
                          {d.slice(0, 3)}
                        </button>
                      )
                    })}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-navy-400">Next run</dt>
                  <dd className="text-navy-200">
                    {e.scheduledEnabled ? formatDateTime(e.nextRunAt) : '—'}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
