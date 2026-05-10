// Phase 4.5 / Sub 4.5.2 — surfaces unprocessed PR comments that will be
// fed into the next session for this project. The data comes from the
// `pr_feedback` table populated by Sub 1; this page is read-only.

import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { GetProjectFeedbackResponse, GetProjectResponse } from '@maestro/api'
import { useApi } from '../hooks/useApi'
import { formatDateTime } from '../lib/format'

export function ProjectFeedback() {
  const { slug } = useParams<{ slug: string }>()
  const api = useApi()
  const [project, setProject] = useState<GetProjectResponse | null>(null)
  const [feedback, setFeedback] = useState<GetProjectFeedbackResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    void Promise.all([
      api.get<GetProjectResponse>(`/api/projects/${encodeURIComponent(slug)}`),
      api.get<GetProjectFeedbackResponse>(
        `/api/projects/${encodeURIComponent(slug)}/feedback`,
      ),
    ])
      .then(([p, f]) => {
        if (cancelled) return
        setProject(p)
        setFeedback(f)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'unknown error')
      })
    return () => {
      cancelled = true
    }
  }, [api, slug])

  if (error) return <ErrorCard message={error} />
  if (!project || !feedback) return <Skeleton />

  const p = project.project
  const repoBase = p.repoUrl.replace(/\.git$/, '')

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <header>
        <Link
          to={`/projects/${encodeURIComponent(p.slug)}`}
          className="text-xs text-amber-400 hover:underline"
        >
          ← {p.slug}
        </Link>
        <h2 className="mt-2 font-mono text-lg text-white">PR feedback</h2>
        <p className="mt-1 text-sm text-navy-400">
          Unprocessed reviewer comments on this project&apos;s open Maestro PRs.
          They are folded into the next session&apos;s prompt automatically. When
          the agent addresses one in its journal entry (e.g.{' '}
          <span className="font-mono">addressed PR #42 feedback</span>) the
          worker marks it processed.
        </p>
      </header>

      {feedback.pending.length === 0 ? (
        <div className="panel px-5 py-6 text-sm text-navy-400">
          No pending feedback. Comments from{' '}
          <span className="font-mono">aaryansinha16</span> on open Maestro PRs
          will appear here within minutes of being posted.
        </div>
      ) : (
        <div className="panel divide-y divide-navy-700/70">
          {feedback.pending.map((f) => (
            <article key={f.id} className="px-5 py-4">
              <header className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <div className="flex items-center gap-2">
                  <a
                    href={`${repoBase}/pull/${f.prNumber}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-amber-300 hover:underline"
                  >
                    PR #{f.prNumber}
                  </a>
                  <span className="font-mono text-xs text-navy-400">{f.prBranch}</span>
                </div>
                <div className="text-xs text-navy-400">
                  <span className="text-navy-100">{f.commentAuthor}</span> ·{' '}
                  {formatDateTime(f.postedAt)}
                </div>
              </header>
              <pre className="mt-3 whitespace-pre-wrap break-words text-sm text-navy-100">
                {f.commentBody}
              </pre>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function Skeleton() {
  return (
    <section className="mx-auto max-w-4xl space-y-4">
      <div className="panel h-16 animate-pulse" />
      <div className="panel h-40 animate-pulse" />
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
