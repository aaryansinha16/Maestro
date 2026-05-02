import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { GetSessionResponse, SessionLogResponse } from '@maestro/api'
import { useApi } from '../hooks/useApi'
import { formatDateTime, formatDuration, gateTag, statusLabel } from '../lib/format'

interface PromptResponse {
  available: boolean
  prompt: string
  reason?: string
}

interface DiffResponse {
  available: boolean
  diff: string
  reason?: string
}

export function SessionDetail() {
  const { id } = useParams<{ id: string }>()
  const api = useApi()
  const [data, setData] = useState<GetSessionResponse | null>(null)
  const [log, setLog] = useState<SessionLogResponse | null>(null)
  const [prompt, setPrompt] = useState<PromptResponse | null>(null)
  const [diff, setDiff] = useState<DiffResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    void Promise.all([
      api.get<GetSessionResponse>(`/api/sessions/${encodeURIComponent(id)}`),
      api.get<SessionLogResponse>(`/api/sessions/${encodeURIComponent(id)}/log`),
      api.get<PromptResponse>(`/api/sessions/${encodeURIComponent(id)}/prompt`),
      api.get<DiffResponse>(`/api/sessions/${encodeURIComponent(id)}/diff`),
    ])
      .then(([detail, l, p, d]) => {
        if (cancelled) return
        setData(detail)
        setLog(l)
        setPrompt(p)
        setDiff(d)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'unknown error')
      })
    return () => {
      cancelled = true
    }
  }, [api, id])

  if (error) {
    return (
      <section className="mx-auto max-w-4xl">
        <div className="panel border-danger/40 bg-danger/10 px-5 py-4 text-sm text-danger">
          {error}
        </div>
      </section>
    )
  }
  if (!data) return <Skeleton />

  const { session, qualityGates } = data

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <header>
        <Link to="/sessions" className="text-xs text-amber-400 hover:underline">
          ← all sessions
        </Link>
        <h2 className="mt-2 font-mono text-lg text-white">{session.id}</h2>
        <p className="text-xs uppercase tracking-[0.2em] text-amber-500">
          Session · {statusLabel(session.status)}
        </p>
      </header>

      <div className="panel grid grid-cols-1 gap-4 px-5 py-4 text-sm sm:grid-cols-2">
        <Field label="Project" value={session.projectId} />
        <Field label="Status" value={statusLabel(session.status)} />
        <Field label="Started" value={formatDateTime(session.startedAt)} />
        <Field label="Ended" value={formatDateTime(session.endedAt)} />
        <Field label="Duration" value={formatDuration(session.startedAt, session.endedAt)} />
        <Field label="Branch" value={session.branchName ?? '—'} mono />
        <Field
          label="PR"
          value={session.prNumber !== null ? `#${session.prNumber}` : '—'}
        />
        <Field label="PR URL" value={session.prUrl ?? '—'} mono />
        <Field label="Termination" value={session.terminationCause ?? '—'} mono />
        <Field
          label="Cost"
          value={
            session.costCents !== null ? `$${(session.costCents / 100).toFixed(2)}` : '—'
          }
        />
        <Field label="Model" value={session.modelUsed ?? '—'} mono />
        <Field label="Prompt version" value={session.promptVersion} mono />
        <Field label="Journal" value={session.journalPath ?? '—'} mono />
        <Field label="Log path" value={session.logPath ?? '—'} mono />
      </div>

      <div className="panel">
        <header className="panel-header">
          <h3 className="font-medium text-white">Quality gates</h3>
          <span className="text-xs text-navy-400">{qualityGates.length} run</span>
        </header>
        <div className="divide-y divide-navy-700/70">
          {qualityGates.length === 0 ? (
            <p className="px-5 py-4 text-sm text-navy-300">No gates ran for this session.</p>
          ) : (
            qualityGates.map((g, i) => (
              <details key={i} className="px-5 py-3">
                <summary className="flex cursor-pointer items-center gap-3">
                  <span className="font-mono text-sm">{gateTag(g.status)}</span>
                  <span className="text-sm font-medium text-navy-100">{g.gateName}</span>
                  <span className="ml-auto text-xs text-navy-400">
                    {g.durationMs ? `${Math.round(g.durationMs / 1000)}s` : ''}
                  </span>
                </summary>
                <pre className="mt-3 max-h-72 overflow-auto rounded-lg border border-navy-700 bg-navy-950/70 p-3 text-xs leading-relaxed text-navy-200">
                  {g.output || '(no output captured)'}
                </pre>
              </details>
            ))
          )}
        </div>
      </div>

      <details className="panel">
        <summary className="panel-header cursor-pointer">
          <h3 className="font-medium text-white">Constructed prompt</h3>
          <span className="text-xs text-navy-400">
            {prompt?.available
              ? `${prompt.prompt.length.toLocaleString()} chars · click to expand`
              : 'unavailable'}
          </span>
        </summary>
        <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap px-5 py-4 text-xs leading-relaxed text-navy-200">
          {prompt?.available ? prompt.prompt : prompt?.reason ?? '(unavailable)'}
        </pre>
      </details>

      <div className="panel">
        <header className="panel-header">
          <h3 className="font-medium text-white">Diff (committed by the agent)</h3>
          {diff?.available ? (
            <span className="text-xs text-navy-400">
              {diff.diff.split('\n').length.toLocaleString()} lines
            </span>
          ) : null}
        </header>
        {diff?.available ? (
          <DiffView diff={diff.diff} />
        ) : (
          <p className="px-5 py-4 text-sm text-navy-400">
            {diff?.reason ?? '(diff unavailable — working clone may have been gc’d)'}
          </p>
        )}
      </div>

      <div className="panel">
        <header className="panel-header">
          <h3 className="font-medium text-white">Log tail</h3>
          {log?.sizeBytes !== undefined ? (
            <span className="text-xs text-navy-400">
              {(log.sizeBytes / 1024).toFixed(1)} KB total
              {log.truncated ? ' · truncated' : ''}
            </span>
          ) : null}
        </header>
        <pre className="max-h-[420px] overflow-auto px-5 py-4 text-xs leading-relaxed text-navy-200">
          {log?.available ? log.tail : '(log not available)'}
        </pre>
      </div>
    </section>
  )
}

// Tiny diff renderer. Not a full syntax highlighter — keeps the bundle
// small. Colors lines by their first character.
function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  return (
    <pre className="max-h-[520px] overflow-auto px-5 py-4 font-mono text-xs leading-relaxed">
      {lines.map((line, i) => {
        const cls = colorForLine(line)
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

function colorForLine(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-amber-300'
  if (line.startsWith('+')) return 'text-success-400'
  if (line.startsWith('-')) return 'text-danger'
  if (line.startsWith('@@')) return 'text-amber-500'
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('commit '))
    return 'text-navy-300'
  if (line.startsWith('Author') || line.startsWith('AuthorDate') || line.startsWith('Commit'))
    return 'text-navy-400'
  return 'text-navy-200'
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
    <section className="mx-auto max-w-4xl space-y-6">
      <div className="panel h-32 animate-pulse" />
      <div className="panel h-48 animate-pulse" />
      <div className="panel h-64 animate-pulse" />
    </section>
  )
}
