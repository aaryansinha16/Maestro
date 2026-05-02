import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { QueueResponse } from '@maestro/api'
import { useApi } from '../hooks/useApi'
import { formatDateTime, formatDuration } from '../lib/format'

const POLL_MS = 5_000

export function Queue() {
  const api = useApi()
  const [data, setData] = useState<QueueResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const fetchOnce = () => {
      void api
        .get<QueueResponse>('/api/queue')
        .then((res) => {
          if (!cancelled) setData(res)
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : 'unknown error')
        })
    }
    fetchOnce()
    const id = window.setInterval(fetchOnce, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [api])

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-amber-500">Phase 2</p>
        <h2 className="mt-1 text-2xl font-semibold text-white">Queue</h2>
        <p className="mt-1 text-sm text-navy-300">
          What's running, what's waiting, what just finished. Polled every {POLL_MS / 1000}s.
        </p>
      </header>

      {error ? (
        <div className="panel border-danger/40 bg-danger/10 px-5 py-4 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {!data ? <div className="panel h-32 animate-pulse" /> : null}

      {data ? (
        <>
          <Section title="Running" jobs={data.running} kind="running" />
          <Section title="Queued" jobs={data.queued} kind="queued" />
          <Section
            title="Recently completed (last 24h)"
            jobs={data.recentlyCompleted}
            kind="completed"
          />
        </>
      ) : null}
    </section>
  )
}

interface SectionProps {
  title: string
  jobs: QueueResponse['running']
  kind: 'running' | 'queued' | 'completed'
}

function Section({ title, jobs, kind }: SectionProps) {
  return (
    <div className="panel">
      <header className="panel-header">
        <h3 className="font-medium text-white">{title}</h3>
        <span className="text-xs text-navy-400">{jobs.length}</span>
      </header>
      {jobs.length === 0 ? (
        <p className="px-5 py-6 text-sm text-navy-400">(empty)</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-navy-400">
            <tr>
              <th className="px-5 py-2">Job</th>
              <th className="px-5 py-2">Project</th>
              <th className="px-5 py-2">Source</th>
              <th className="px-5 py-2">Status</th>
              <th className="px-5 py-2">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-navy-700/70">
            {jobs.map((j) => {
              const time =
                kind === 'running'
                  ? `running for ${formatDuration(j.startedAt ?? j.enqueuedAt, null)}`
                  : kind === 'queued'
                    ? `queued ${formatDateTime(j.enqueuedAt)}`
                    : `${formatDateTime(j.endedAt)} · ${formatDuration(
                        j.startedAt ?? j.enqueuedAt,
                        j.endedAt,
                      )}`
              return (
                <tr key={j.id}>
                  <td className="px-5 py-2 font-mono text-navy-200">{j.id.slice(0, 8)}</td>
                  <td className="px-5 py-2">
                    {j.sessionId ? (
                      <Link
                        to={`/sessions/${j.sessionId}`}
                        className="text-amber-400 hover:underline"
                      >
                        session →
                      </Link>
                    ) : (
                      <span className="font-mono text-xs text-navy-300">{j.projectId.slice(0, 8)}</span>
                    )}
                  </td>
                  <td className="px-5 py-2 text-navy-200">{j.source}</td>
                  <td className="px-5 py-2 text-navy-200">{j.status}</td>
                  <td className="px-5 py-2 text-navy-300">{time}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
