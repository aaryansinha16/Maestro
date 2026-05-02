import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { ListSessionsResponse } from '@maestro/api'
import { useApi } from '../hooks/useApi'
import { formatDuration, formatDateTime, statusLabel } from '../lib/format'

export function Sessions() {
  const api = useApi()
  const [params, setParams] = useSearchParams()
  const projectId = params.get('projectId') ?? undefined
  const [data, setData] = useState<ListSessionsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const url = projectId
      ? `/api/sessions?projectId=${encodeURIComponent(projectId)}`
      : '/api/sessions'
    api
      .get<ListSessionsResponse>(url)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'unknown error')
      })
    return () => {
      cancelled = true
    }
  }, [api, projectId])

  return (
    <section className="mx-auto max-w-6xl">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-amber-500">Activity</p>
          <h2 className="mt-1 text-2xl font-semibold text-white">Sessions</h2>
          <p className="mt-1 text-sm text-navy-300">
            Every Maestro-driven session, newest first. Click into one to see the full log,
            quality-gate output, and journal entry.
          </p>
        </div>
        {projectId ? (
          <button
            onClick={() => setParams({})}
            className="text-xs text-amber-400 hover:underline"
          >
            clear project filter
          </button>
        ) : null}
      </header>

      {error ? (
        <div className="panel mb-6 border-danger/40 bg-danger/10 px-5 py-4 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {!data ? (
        <SkeletonList />
      ) : data.sessions.length === 0 ? (
        <Empty />
      ) : (
        <div className="panel divide-y divide-navy-700/70">
          {data.sessions.map((s) => (
            <Link
              key={s.id}
              to={`/sessions/${s.id}`}
              className="flex items-center justify-between gap-4 px-5 py-3 transition hover:bg-navy-700/30"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <span className={`pill ${pillFor(s.status)}`}>{statusLabel(s.status)}</span>
                  <span className="font-mono text-sm text-navy-100">{s.id.slice(0, 8)}</span>
                  {s.isFixupTurn ? <span className="pill">fixup</span> : null}
                </div>
                <div className="mt-1 truncate text-xs text-navy-400">
                  {s.branchName ?? '(no branch)'} · model {s.modelUsed ?? '—'}
                </div>
              </div>
              <div className="text-right text-xs text-navy-300">
                <div>{formatDateTime(s.startedAt)}</div>
                <div className="text-navy-400">
                  {formatDuration(s.startedAt, s.endedAt)}
                  {s.prNumber !== null ? `  ·  PR #${s.prNumber}` : ''}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  )
}

function Empty() {
  return (
    <div className="panel px-6 py-16 text-center">
      <h3 className="text-lg font-semibold text-white">No sessions yet</h3>
      <p className="mt-2 text-sm text-navy-300">
        Trigger a session from the CLI:{' '}
        <code className="rounded bg-navy-950/70 px-2 py-0.5 text-amber-200">
          maestro run &lt;slug&gt;
        </code>
      </p>
    </div>
  )
}

function SkeletonList() {
  return (
    <div className="panel divide-y divide-navy-700/70">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-16 animate-pulse" />
      ))}
    </div>
  )
}

function pillFor(status: string): string {
  switch (status) {
    case 'completed':
      return 'pill-success'
    case 'failed':
    case 'quality-gate-failed':
    case 'timed-out':
      return 'border-danger/60 bg-danger/10 text-danger'
    case 'running':
    case 'pending':
      return 'pill-amber'
    default:
      return ''
  }
}
