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
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-amber-500">Projects</p>
          <h2 className="mt-1 text-2xl font-semibold text-white">Overview</h2>
          <p className="mt-1 text-sm text-navy-300">
            All projects under Maestro management. Each card surfaces current autonomy and
            recent activity.
          </p>
        </div>
        <Link
          to="/add-project"
          className="rounded border border-amber-400/60 bg-amber-400/10 px-4 py-1.5 text-sm font-medium text-amber-200 transition hover:bg-amber-400/20"
        >
          + Add project
        </Link>
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
    <div className="space-y-4">
      <SetupChecklist />
      <div className="panel flex flex-col items-center justify-center px-8 py-12 text-center">
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
        <h3 className="text-lg font-semibold text-white">Add your first project</h3>
        <p className="mt-2 max-w-md text-sm text-navy-300">
          Onboard a GitHub repo through the guided wizard. The first session is orientation
          only — no code changes, just observation.
        </p>
        <Link
          to="/add-project"
          className="mt-5 rounded border border-amber-400/60 bg-amber-400/10 px-4 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-400/20"
        >
          Open the add-project wizard →
        </Link>
        <p className="mt-4 text-xs text-navy-400">
          or from the CLI:
          <code className="ml-2 rounded bg-navy-950/70 px-2 py-0.5 text-amber-200">
            maestro init &lt;path&gt; &amp;&amp; maestro add &lt;repo-url&gt;
          </code>
        </p>
      </div>
    </div>
  )
}

interface SetupSettings {
  authEnabled: boolean
  githubConfigured: boolean
  claudeTokenAuth: boolean
}
interface ClaudeHealth {
  installed: boolean
  authenticated: boolean | null
}

// SH-03: first-run setup checklist. Reads /api/settings + /api/health/claude so
// a fresh self-hoster can see, at a glance, what still needs configuring.
function SetupChecklist() {
  const api = useApi()
  const [settings, setSettings] = useState<SetupSettings | null>(null)
  const [claude, setClaude] = useState<ClaudeHealth | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      api.get<SetupSettings>('/api/settings').catch(() => null),
      api.get<ClaudeHealth>('/api/health/claude').catch(() => null),
    ]).then(([s, c]) => {
      if (cancelled) return
      setSettings(s)
      setClaude(c)
    })
    return () => {
      cancelled = true
    }
  }, [api])

  const items = [
    {
      label: 'GitHub token',
      done: settings?.githubConfigured ?? false,
      hint: 'Set GITHUB_TOKEN (a fine-grained PAT with contents + pull-requests write) so Maestro can push branches and open PRs.',
    },
    {
      label: 'Claude authenticated',
      done: claude ? claude.installed && claude.authenticated !== false : false,
      hint: 'Run `claude /login` on the host, or set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) for a headless instance.',
    },
    {
      label: 'Dashboard auth',
      done: settings?.authEnabled ?? false,
      hint: 'Set MAESTRO_AUTH_USER + MAESTRO_AUTH_PASSWORD before exposing this instance publicly (required in production).',
    },
    { label: 'First project added', done: false, hint: 'Register a repo below to start.' },
  ]

  return (
    <div className="panel px-6 py-5">
      <h3 className="text-sm font-semibold text-white">Setup checklist</h3>
      <p className="mt-1 text-xs text-navy-400">
        Get your instance ready. Config comes from environment variables — see{' '}
        <Link to="/settings" className="text-amber-400 hover:underline">
          Settings
        </Link>
        .
      </p>
      <ul className="mt-4 space-y-3">
        {items.map((it) => (
          <li key={it.label} className="flex gap-3 text-sm">
            <span className={it.done ? 'text-success-400' : 'text-amber-300'}>
              {it.done ? '✓' : '•'}
            </span>
            <div>
              <div className={it.done ? 'text-navy-200' : 'text-white'}>{it.label}</div>
              {!it.done ? <div className="mt-0.5 text-xs text-navy-400">{it.hint}</div> : null}
            </div>
          </li>
        ))}
      </ul>
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
