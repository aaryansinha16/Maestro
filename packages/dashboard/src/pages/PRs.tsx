import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../hooks/useApi'
import { formatDateTime } from '../lib/format'

interface OpenPR {
  sessionId: string
  projectSlug: string
  repoUrl: string | null
  prNumber: number | null
  prUrl: string | null
  branchName: string | null
  status: string
  startedAt: string
  endedAt: string | null
  costCents: number | null
}

interface PRsResponse {
  pullRequests: OpenPR[]
}

export function PRs() {
  const api = useApi()
  const [data, setData] = useState<PRsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [merge, setMerge] = useState<
    Record<string, { kind: 'pending' } | { kind: 'merged' } | { kind: 'err'; message: string }>
  >({})

  const mergePr = async (pr: OpenPR) => {
    if (pr.prNumber === null) return
    setMerge((m) => ({ ...m, [pr.sessionId]: { kind: 'pending' } }))
    try {
      const res = await api.post<{ merged: boolean; sha?: string; reason?: string }>(
        `/api/projects/${encodeURIComponent(pr.projectSlug)}/prs/${pr.prNumber}/merge`,
      )
      setMerge((m) => ({
        ...m,
        [pr.sessionId]: res.merged
          ? { kind: 'merged' }
          : { kind: 'err', message: res.reason ?? 'merge blocked' },
      }))
    } catch (err) {
      setMerge((m) => ({
        ...m,
        [pr.sessionId]: { kind: 'err', message: err instanceof Error ? err.message : 'merge failed' },
      }))
    }
  }

  const mergeError = (sid: string): string | null => {
    const s = merge[sid]
    return s && s.kind === 'err' ? s.message : null
  }

  useEffect(() => {
    let cancelled = false
    api
      .get<PRsResponse>('/api/prs')
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'unknown error')
      })
    return () => {
      cancelled = true
    }
  }, [api])

  // Surface oldest-first so nothing slips through the cracks.
  const sorted = data
    ? [...data.pullRequests].sort(
        (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
      )
    : []

  return (
    <section className="mx-auto max-w-5xl">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-[0.2em] text-amber-500">Review queue</p>
        <h2 className="mt-1 text-2xl font-semibold text-white">Pull Requests</h2>
        <p className="mt-1 text-sm text-navy-300">
          PRs Maestro has opened, oldest first. Click through to GitHub or open the originating
          session.
        </p>
      </header>

      {error ? (
        <div className="panel mb-6 border-danger/40 bg-danger/10 px-5 py-4 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {!data ? (
        <div className="panel h-32 animate-pulse" />
      ) : sorted.length === 0 ? (
        <div className="panel px-6 py-12 text-center">
          <h3 className="text-lg font-semibold text-white">Inbox zero.</h3>
          <p className="mt-2 text-sm text-navy-300">
            No open Maestro PRs across any registered project.
          </p>
        </div>
      ) : (
        <div className="panel divide-y divide-navy-700/70">
          {sorted.map((pr) => (
            <article key={pr.sessionId} className="grid grid-cols-1 gap-2 px-5 py-3 md:grid-cols-[1fr_auto]">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/projects/${pr.projectSlug}`} className="font-mono text-sm text-navy-100 hover:underline">
                    {pr.projectSlug}
                  </Link>
                  {pr.prNumber !== null ? (
                    <span className="pill pill-amber">#{pr.prNumber}</span>
                  ) : null}
                  <span className="pill">{pr.status}</span>
                </div>
                <div className="mt-1 truncate text-xs text-navy-400">
                  branch <span className="font-mono">{pr.branchName ?? '—'}</span>
                  {pr.costCents !== null ? ` · cost $${(pr.costCents / 100).toFixed(2)}` : ''}
                </div>
              </div>
              <div className="flex flex-col items-start gap-1 text-xs md:items-end">
                <span className="text-navy-300">{formatDateTime(pr.startedAt)}</span>
                <div className="flex items-center gap-2">
                  {pr.prNumber !== null && merge[pr.sessionId]?.kind !== 'merged' ? (
                    <button
                      type="button"
                      onClick={() => void mergePr(pr)}
                      disabled={merge[pr.sessionId]?.kind === 'pending'}
                      className="rounded border border-success-500/50 bg-success-500/10 px-2 py-0.5 text-success-400 transition hover:bg-success-500/20 disabled:opacity-40"
                      title="Squash-merge this PR on GitHub"
                    >
                      {merge[pr.sessionId]?.kind === 'pending' ? 'Merging…' : 'Merge'}
                    </button>
                  ) : null}
                  {merge[pr.sessionId]?.kind === 'merged' ? (
                    <span className="text-success-400">merged ✓</span>
                  ) : null}
                  {pr.prUrl ? (
                    <a
                      href={pr.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-amber-400 hover:underline"
                    >
                      view on GitHub →
                    </a>
                  ) : null}
                  <Link to={`/sessions/${pr.sessionId}`} className="text-navy-300 hover:underline">
                    session
                  </Link>
                </div>
                {mergeError(pr.sessionId) ? (
                  <span className="text-danger">{mergeError(pr.sessionId)}</span>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
