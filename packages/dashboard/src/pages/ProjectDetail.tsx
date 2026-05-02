import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type {
  GetProjectResponse,
  ListSessionsResponse,
  CostAggregationsResponse,
} from '@maestro/api'
import { useApi } from '../hooks/useApi'
import { formatDateTime, formatDuration, statusLabel } from '../lib/format'

export function ProjectDetail() {
  const { slug } = useParams<{ slug: string }>()
  const api = useApi()
  const [project, setProject] = useState<GetProjectResponse | null>(null)
  const [sessions, setSessions] = useState<ListSessionsResponse | null>(null)
  const [costs, setCosts] = useState<CostAggregationsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    void Promise.all([
      api.get<GetProjectResponse>(`/api/projects/${encodeURIComponent(slug)}`),
      api.get<CostAggregationsResponse>('/api/costs'),
    ])
      .then(async ([p, c]) => {
        if (cancelled) return
        setProject(p)
        setCosts(c)
        const s = await api.get<ListSessionsResponse>(
          `/api/sessions?projectId=${encodeURIComponent(p.project.id)}&limit=20`,
        )
        if (!cancelled) setSessions(s)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'unknown error')
      })
    return () => {
      cancelled = true
    }
  }, [api, slug])

  if (error) return <ErrorCard message={error} />
  if (!project) return <Skeleton />

  const p = project.project
  const projCost = costs?.perProject.find((x) => x.projectId === p.id) ?? null

  return (
    <section className="mx-auto max-w-5xl space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to="/" className="text-xs text-amber-400 hover:underline">
            ← all projects
          </Link>
          <h2 className="mt-2 font-mono text-lg text-white">{p.slug}</h2>
          <p className="mt-1 text-xs text-navy-400">
            <a href={p.repoUrl} target="_blank" rel="noreferrer" className="hover:underline">
              {p.repoUrl}
            </a>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="pill pill-amber">{p.autonomyConfig.level}</span>
          <span className="pill">budget {Math.round(p.autonomyConfig.timeBudget / 60)}m</span>
          <span className="pill font-mono">{p.autonomyConfig.schedule}</span>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Sessions (30d)"
          value={projCost ? String(projCost.sessionCount) : '—'}
        />
        <Stat
          label="PRs (30d)"
          value={projCost ? String(projCost.prCount) : '—'}
        />
        <Stat
          label="Spend (30d)"
          value={projCost ? `$${(projCost.monthCents / 100).toFixed(2)}` : '—'}
        />
        <Stat
          label="¢ / PR (30d)"
          value={
            projCost?.centsPerPr !== null && projCost?.centsPerPr !== undefined
              ? `$${(projCost.centsPerPr / 100).toFixed(2)}`
              : '—'
          }
        />
      </div>

      <div className="panel">
        <header className="panel-header">
          <h3 className="font-medium text-white">Recent sessions</h3>
          <span className="text-xs text-navy-400">{sessions?.sessions.length ?? 0} shown</span>
        </header>
        {!sessions ? (
          <div className="px-5 py-6 text-sm text-navy-400">Loading…</div>
        ) : sessions.sessions.length === 0 ? (
          <div className="px-5 py-6 text-sm text-navy-400">No sessions yet.</div>
        ) : (
          <div className="divide-y divide-navy-700/70">
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
                    {s.isFixupTurn ? <span className="pill">fixup</span> : null}
                  </div>
                  <div className="mt-1 truncate text-xs text-navy-400">
                    {s.branchName ?? '(no branch)'}
                    {s.prNumber !== null ? ` · PR #${s.prNumber}` : ''}
                  </div>
                </div>
                <div className="text-right text-xs text-navy-300">
                  <div>{formatDateTime(s.startedAt)}</div>
                  <div className="text-navy-400">
                    {formatDuration(s.startedAt, s.endedAt)}
                    {s.costCents !== null ? ` · $${(s.costCents / 100).toFixed(2)}` : ''}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="panel">
        <header className="panel-header">
          <h3 className="font-medium text-white">Configuration</h3>
        </header>
        <dl className="grid grid-cols-1 gap-3 px-5 py-4 text-sm md:grid-cols-2">
          <Field label="Quality gates" value={p.autonomyConfig.qualityGates.join(', ') || '—'} />
          <Field
            label="Branch prefix"
            value={p.autonomyConfig.branches.prefix}
            mono
          />
          <Field label="Base branch" value={p.autonomyConfig.branches.base} mono />
          <Field
            label="PR labels"
            value={p.autonomyConfig.github.prLabels.join(', ') || '—'}
          />
          <Field
            label="Draft by default"
            value={p.autonomyConfig.github.draftByDefault ? 'yes' : 'no'}
          />
          <Field label="Max sessions / day" value={String(p.autonomyConfig.maxSessionsPerDay)} />
        </dl>
      </div>

      <p className="text-xs text-navy-400">
        Note: state.md and context.md live in the project's git repo (
        <a className="hover:underline" href={p.repoUrl} target="_blank" rel="noreferrer">
          {p.repoUrl.replace(/^https?:\/\//, '')}
        </a>
        ). Edit them via git, not the dashboard.
      </p>
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-navy-400">{label}</div>
      <div className="mt-1 text-lg font-semibold text-white">{value}</div>
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-navy-400">{label}</div>
      <div className={mono ? 'font-mono text-navy-100' : 'text-navy-100'}>{value}</div>
    </div>
  )
}

function Skeleton() {
  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <div className="panel h-24 animate-pulse" />
      <div className="panel h-40 animate-pulse" />
      <div className="panel h-64 animate-pulse" />
    </section>
  )
}

function ErrorCard({ message }: { message: string }) {
  return (
    <section className="mx-auto max-w-3xl">
      <div className="panel border-danger/40 bg-danger/10 px-5 py-4 text-sm text-danger">
        {message}
      </div>
    </section>
  )
}
