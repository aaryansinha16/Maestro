import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ListProjectsResponse, ListSessionsResponse } from '@maestro/api'
import { useApi } from '../hooks/useApi'
import { formatDateTime, formatDuration, statusLabel } from '../lib/format'

export function Overview() {
  const api = useApi()
  const [projects, setProjects] = useState<ListProjectsResponse | null>(null)
  const [sessions, setSessions] = useState<ListSessionsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      api.get<ListProjectsResponse>('/api/projects'),
      api.get<ListSessionsResponse>('/api/sessions?limit=5'),
    ])
      .then(([p, s]) => {
        if (cancelled) return
        setProjects(p)
        setSessions(s)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error')
      })
    return () => {
      cancelled = true
    }
  }, [api])

  return (
    <section className="mx-auto max-w-6xl space-y-8">
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-amber-500">Projects</p>
        <h2 className="mt-1 text-2xl font-semibold text-white">Overview</h2>
        <p className="mt-1 text-sm text-navy-300">
          All projects under Maestro management. Each card surfaces current autonomy and
          recent activity.
        </p>
      </header>

      {error ? <ErrorCard message={error} /> : null}

      {!projects ? (
        <SkeletonGrid />
      ) : projects.projects.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.projects.map((p) => (
            <Link key={p.id} to={`/projects/${p.slug}`} className="panel block p-5 transition hover:border-amber-700/60">
              <div className="flex items-center justify-between">
                <h3 className="font-mono text-sm text-navy-100">{p.slug}</h3>
                <span className="pill pill-amber">{p.autonomyConfig.level}</span>
              </div>
              <p className="mt-2 truncate text-xs text-navy-400">{p.repoUrl}</p>
              <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <dt className="text-navy-400">Schedule</dt>
                  <dd className="font-mono text-navy-200">{p.autonomyConfig.schedule}</dd>
                </div>
                <div>
                  <dt className="text-navy-400">Budget</dt>
                  <dd className="text-navy-200">
                    {Math.round(p.autonomyConfig.timeBudget / 60)}m
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-navy-400">Gates</dt>
                  <dd className="font-mono text-navy-200">
                    {p.autonomyConfig.qualityGates.join(', ')}
                  </dd>
                </div>
              </dl>
            </Link>
          ))}
        </div>
      )}

      {sessions && sessions.sessions.length > 0 ? (
        <div>
          <header className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-navy-100">Recent sessions</h3>
            <Link to="/sessions" className="text-xs text-amber-400 hover:underline">
              all sessions →
            </Link>
          </header>
          <div className="panel divide-y divide-navy-700/70">
            {sessions.sessions.map((s) => (
              <Link
                key={s.id}
                to={`/sessions/${s.id}`}
                className="flex items-center justify-between gap-4 px-5 py-3 transition hover:bg-navy-700/30"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="pill">{statusLabel(s.status)}</span>
                    <span className="font-mono text-sm text-navy-100">{s.id.slice(0, 8)}</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-navy-400">
                    {s.branchName ?? '(no branch)'}
                  </div>
                </div>
                <div className="text-right text-xs text-navy-300">
                  <div>{formatDateTime(s.startedAt)}</div>
                  <div className="text-navy-400">
                    {formatDuration(s.startedAt, s.endedAt)}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}

function EmptyState() {
  return (
    <div className="panel flex flex-col items-center justify-center px-8 py-16 text-center">
      <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl border border-amber-700/40 bg-amber-900/20 text-amber-400">
        <svg width="24" height="24" viewBox="0 0 64 64" aria-hidden>
          <path
            d="M16 46V18l8 12 8-12 8 12 8-12v28"
            stroke="currentColor"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </div>
      <h3 className="text-lg font-semibold text-white">No projects yet</h3>
      <p className="mt-2 max-w-md text-sm text-navy-300">
        Initialise <code>.maestro/</code> in a repo and register it. The first session is for
        orientation only — no code changes, just observation.
      </p>
      <pre className="mt-6 inline-block rounded-lg border border-navy-700 bg-navy-950/70 px-4 py-2 text-xs text-amber-200">
        maestro init &lt;path&gt;{'\n'}maestro add &lt;repo-url&gt;
      </pre>
    </div>
  )
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="panel h-40 animate-pulse" />
      ))}
    </div>
  )
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div className="panel mb-6 border-danger/40 bg-danger/10 px-5 py-4 text-sm text-danger">
      Conductor unreachable: <span className="font-mono">{message}</span>
    </div>
  )
}
