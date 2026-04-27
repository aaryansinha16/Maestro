import { useEffect, useState } from 'react'
import { useApi } from '../hooks/useApi'
import type { ListProjectsResponse } from '@maestro/api'

export function Overview() {
  const api = useApi()
  const [data, setData] = useState<ListProjectsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api
      .get<ListProjectsResponse>('/api/projects')
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error')
      })
    return () => {
      cancelled = true
    }
  }, [api])

  return (
    <section className="mx-auto max-w-6xl">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-[0.2em] text-amber-500">Projects</p>
        <h2 className="mt-1 text-2xl font-semibold text-white">Overview</h2>
        <p className="mt-1 text-sm text-navy-300">
          All projects under Maestro management. Each card surfaces current state, recent
          activity, and pending review.
        </p>
      </header>

      {error ? <ErrorCard message={error} /> : null}

      {!data ? (
        <SkeletonGrid />
      ) : data.projects.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.projects.map((p) => (
            <article key={p.id} className="panel p-5">
              <h3 className="font-mono text-sm text-navy-200">{p.slug}</h3>
              <p className="mt-2 text-xs text-navy-400">{p.repoUrl}</p>
              <span className="pill pill-amber mt-4">{p.autonomyConfig.level}</span>
            </article>
          ))}
        </div>
      )}
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
        Add a repository to put it under autonomous management. The first session is for
        orientation — no code changes, just observation.
      </p>
      <pre className="mt-6 inline-block rounded-lg border border-navy-700 bg-navy-950/70 px-4 py-2 text-xs text-amber-200">
        maestro add &lt;repo-url&gt;
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
