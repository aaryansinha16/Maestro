import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type {
  GetProjectResponse,
  GetProjectFeedbackResponse,
  ListScheduleResponse,
  ListSessionsResponse,
  ListSkipsResponse,
  CostAggregationsResponse,
  UpdateAutonomyBody,
} from '@maestro/api'
import { useApi } from '../hooks/useApi'
import { formatDateTime, formatDuration, statusLabel } from '../lib/format'
import { AutonomyForm } from '../components/AutonomyForm'

export function ProjectDetail() {
  const { slug } = useParams<{ slug: string }>()
  const api = useApi()
  const [project, setProject] = useState<GetProjectResponse | null>(null)
  const [sessions, setSessions] = useState<ListSessionsResponse | null>(null)
  const [costs, setCosts] = useState<CostAggregationsResponse | null>(null)
  const [feedback, setFeedback] = useState<GetProjectFeedbackResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [triggerState, setTriggerState] = useState<
    { kind: 'idle' } | { kind: 'pending' } | { kind: 'ok'; jobId: string } | { kind: 'err'; message: string }
  >({ kind: 'idle' })

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    void Promise.all([
      api.get<GetProjectResponse>(`/api/projects/${encodeURIComponent(slug)}`),
      api.get<CostAggregationsResponse>('/api/costs'),
      api
        .get<GetProjectFeedbackResponse>(
          `/api/projects/${encodeURIComponent(slug)}/feedback`,
        )
        .catch(() => ({ pending: [], pendingCount: 0 }) as GetProjectFeedbackResponse),
    ])
      .then(async ([p, c, f]) => {
        if (cancelled) return
        setProject(p)
        setCosts(c)
        setFeedback(f)
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
  const isPaused = p.autonomyConfig.level === 'paused' || p.autoPausedAt !== null

  const triggerNow = async () => {
    setTriggerState({ kind: 'pending' })
    try {
      const res = await api.post<{ ok: true; jobId: string }>(
        `/api/projects/${encodeURIComponent(p.slug)}/trigger`,
      )
      setTriggerState({ kind: 'ok', jobId: res.jobId })
    } catch (err) {
      setTriggerState({
        kind: 'err',
        message: err instanceof Error ? err.message : 'failed to trigger',
      })
    }
  }

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
          {feedback && feedback.pendingCount > 0 ? (
            <Link
              to={`/projects/${encodeURIComponent(p.slug)}/feedback`}
              className="pill pill-amber hover:bg-amber-400/30"
              title="Reviewer comments waiting to be folded into the next session"
            >
              Feedback ({feedback.pendingCount})
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => void triggerNow()}
            disabled={isPaused || triggerState.kind === 'pending'}
            title={
              isPaused
                ? 'Project is paused — resume it before triggering'
                : 'Enqueue a manual session with priority 100'
            }
            className="rounded border border-amber-400/60 bg-amber-400/10 px-3 py-1 text-xs font-medium text-amber-200 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-amber-400/10"
          >
            {triggerState.kind === 'pending' ? 'Triggering…' : 'Trigger now'}
          </button>
        </div>
      </header>

      {triggerState.kind === 'ok' ? (
        <div className="panel border-success-500/40 bg-success-500/10 px-4 py-2 text-sm text-success-400">
          Session enqueued — job{' '}
          <Link to="/queue" className="font-mono text-success-400 hover:underline">
            {triggerState.jobId.slice(0, 8)}
          </Link>
          . Watch progress on{' '}
          <Link to="/queue" className="text-success-400 hover:underline">
            the queue page
          </Link>
          .
        </div>
      ) : null}
      {triggerState.kind === 'err' ? (
        <div className="panel border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
          Trigger failed: {triggerState.message}
        </div>
      ) : null}

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

      <SchedulingPanel slug={p.slug} />

      <ConfigurationPanel
        project={p}
        onSaved={async () => {
          const next = await api.get<GetProjectResponse>(
            `/api/projects/${encodeURIComponent(p.slug)}`,
          )
          setProject(next)
        }}
      />

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

function ConfigurationPanel({
  project,
  onSaved,
}: {
  project: GetProjectResponse['project']
  onSaved: () => Promise<void> | void
}) {
  const api = useApi()
  const [editing, setEditing] = useState(false)

  const save = async (patch: UpdateAutonomyBody) => {
    await api.post(`/api/projects/${encodeURIComponent(project.slug)}/autonomy`, patch)
    await onSaved()
    setEditing(false)
  }

  return (
    <div className="panel">
      <header className="panel-header">
        <h3 className="font-medium text-white">Configuration</h3>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="text-xs text-amber-400 hover:underline"
        >
          {editing ? 'cancel' : 'edit autonomy'}
        </button>
      </header>
      {editing ? (
        <AutonomyForm
          value={project.autonomyConfig}
          onSubmit={save}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <dl className="grid grid-cols-1 gap-3 px-5 py-4 text-sm md:grid-cols-2">
          <Field label="Quality gates" value={project.autonomyConfig.qualityGates.join(', ') || '—'} />
          <Field label="Branch prefix" value={project.autonomyConfig.branches.prefix} mono />
          <Field label="Base branch" value={project.autonomyConfig.branches.base} mono />
          <Field
            label="PR labels"
            value={project.autonomyConfig.github.prLabels.join(', ') || '—'}
          />
          <Field
            label="Draft by default"
            value={project.autonomyConfig.github.draftByDefault ? 'yes' : 'no'}
          />
          <Field
            label="Max sessions / day"
            value={String(project.autonomyConfig.maxSessionsPerDay)}
          />
          <Field
            label="Continue until budget"
            value={project.autonomyConfig.continueUntilBudget ? 'enabled' : 'disabled'}
          />
          <Field
            label="Min time for continuation"
            value={`${Math.round(project.autonomyConfig.minTimeForContinuation / 60)}m`}
          />
        </dl>
      )}
    </div>
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

function SchedulingPanel({ slug }: { slug: string }) {
  const api = useApi()
  const [schedule, setSchedule] = useState<ListScheduleResponse | null>(null)
  const [skips, setSkips] = useState<ListSkipsResponse | null>(null)
  useEffect(() => {
    let cancelled = false
    void Promise.all([
      api.get<ListScheduleResponse>('/api/schedule'),
      api.get<ListSkipsResponse>(`/api/projects/${encodeURIComponent(slug)}/skips?limit=10`),
    ])
      .then(([s, sk]) => {
        if (cancelled) return
        setSchedule(s)
        setSkips(sk)
      })
      .catch(() => {
        /* ignore — section is informational */
      })
    return () => {
      cancelled = true
    }
  }, [api, slug])
  const entry = schedule?.entries.find((e) => e.slug === slug)

  const resume = async () => {
    await api.post(`/api/projects/${encodeURIComponent(slug)}/resume`)
    const next = await api.get<ListScheduleResponse>('/api/schedule')
    setSchedule(next)
  }

  const pause = async () => {
    const reason = window.prompt('Pause reason (will appear in scheduled-runs audit log):', 'manual pause from dashboard')
    if (reason === null) return // cancelled
    await api.post(`/api/projects/${encodeURIComponent(slug)}/pause`, { reason })
    const next = await api.get<ListScheduleResponse>('/api/schedule')
    setSchedule(next)
  }

  return (
    <div className="panel">
      <header className="panel-header">
        <h3 className="font-medium text-white">Scheduling</h3>
        {entry?.autoPausedAt ? (
          <button
            onClick={() => void resume()}
            className="text-xs text-amber-400 hover:underline"
          >
            resume now
          </button>
        ) : (
          <button
            onClick={() => void pause()}
            className="text-xs text-navy-400 hover:text-amber-400 hover:underline"
          >
            pause
          </button>
        )}
      </header>
      <div className="grid grid-cols-1 gap-3 px-5 py-4 text-sm md:grid-cols-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-navy-400">Enabled</div>
          <div className="text-navy-100">{entry?.scheduledEnabled ? 'yes' : 'no'}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-navy-400">Schedule</div>
          <div className="font-mono text-navy-100">{entry?.schedule ?? '—'}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-navy-400">Next run</div>
          <div className="text-navy-100">
            {entry?.scheduledEnabled
              ? entry?.nextRunAt
                ? new Date(entry.nextRunAt).toLocaleString()
                : '—'
              : '—'}
          </div>
        </div>
        {entry?.autoPausedAt ? (
          <div className="md:col-span-3">
            <div className="text-xs uppercase tracking-wide text-amber-500">Auto-paused</div>
            <div className="text-amber-300">{entry.autoPauseReason ?? '(no reason)'}</div>
          </div>
        ) : null}
      </div>
      <header className="panel-header">
        <h4 className="text-xs uppercase tracking-wide text-navy-400">Recent skips</h4>
      </header>
      <div className="px-5 py-3 text-xs text-navy-300">
        {!skips || skips.skips.length === 0
          ? '(none yet)'
          : skips.skips.map((s) => (
              <div key={s.id} className="flex justify-between border-b border-navy-700/50 py-1">
                <span>
                  <span className="font-mono">{s.action}</span>
                  {s.skipReason ? <span className="ml-2">{s.skipReason}</span> : null}
                </span>
                <span className="text-navy-400">{new Date(s.firedAt).toLocaleString()}</span>
              </div>
            ))}
      </div>
    </div>
  )
}
