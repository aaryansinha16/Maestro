import { useEffect, useState } from 'react'
import type { CostAggregationsResponse } from '@maestro/api'
import { useApi } from '../hooks/useApi'

export function Costs() {
  const api = useApi()
  const [data, setData] = useState<CostAggregationsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<CostAggregationsResponse>('/api/costs')
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

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-amber-500">Spend</p>
        <h2 className="mt-1 text-2xl font-semibold text-white">Costs</h2>
        <p className="mt-1 text-sm text-navy-300">
          Rolling 30-day Anthropic spend across all Maestro sessions, with per-project breakdown
          and a cost-per-merged-PR efficiency metric.
        </p>
      </header>

      {error ? (
        <div className="panel border-danger/40 bg-danger/10 px-5 py-4 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {!data ? (
        <div className="panel h-32 animate-pulse" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Today" value={`$${(data.todayCents / 100).toFixed(2)}`} />
            <Stat label="Last 30d" value={`$${(data.monthCents / 100).toFixed(2)}`} />
            <Stat
              label="Monthly budget"
              value={`$${(data.monthlyBudgetCents / 100).toFixed(2)}`}
            />
            <Stat
              label="Used"
              value={`${(data.budgetFractionUsed * 100).toFixed(1)}%`}
              warn={data.budgetFractionUsed >= 0.8}
            />
          </div>

          <div className="panel">
            <header className="panel-header">
              <h3 className="font-medium text-white">Daily spend (30d)</h3>
              <span className="text-xs text-navy-400">{data.dailySeries.length} days</span>
            </header>
            <DailySparkline data={data.dailySeries} />
          </div>

          <div className="panel">
            <header className="panel-header">
              <h3 className="font-medium text-white">Per project (30d)</h3>
            </header>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-navy-400">
                <tr>
                  <th className="px-5 py-2">Project</th>
                  <th className="px-5 py-2 text-right">Sessions</th>
                  <th className="px-5 py-2 text-right">PRs</th>
                  <th className="px-5 py-2 text-right">Spend</th>
                  <th className="px-5 py-2 text-right">$ / PR</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-700/70">
                {data.perProject.map((p) => (
                  <tr key={p.projectId}>
                    <td className="px-5 py-2 font-mono text-navy-100">{p.projectSlug}</td>
                    <td className="px-5 py-2 text-right text-navy-200">{p.sessionCount}</td>
                    <td className="px-5 py-2 text-right text-navy-200">{p.prCount}</td>
                    <td className="px-5 py-2 text-right text-navy-200">
                      ${(p.monthCents / 100).toFixed(2)}
                    </td>
                    <td className="px-5 py-2 text-right text-navy-200">
                      {p.centsPerPr !== null ? `$${(p.centsPerPr / 100).toFixed(2)}` : '—'}
                    </td>
                  </tr>
                ))}
                {data.perProject.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-6 text-center text-sm text-navy-400">
                      No spend yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`panel px-4 py-3 ${warn ? 'border-amber-700/60' : ''}`}>
      <div className="text-xs uppercase tracking-wide text-navy-400">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${warn ? 'text-amber-300' : 'text-white'}`}>
        {value}
      </div>
    </div>
  )
}

function DailySparkline({ data }: { data: Array<{ date: string; cents: number }> }) {
  const max = Math.max(1, ...data.map((d) => d.cents))
  return (
    <div className="px-5 py-4">
      <div className="flex h-32 items-end gap-[2px]">
        {data.map((d) => {
          const height = (d.cents / max) * 100
          return (
            <div
              key={d.date}
              className="relative flex-1 rounded-t bg-amber-500/40 hover:bg-amber-500/70"
              style={{ height: `${Math.max(2, height)}%` }}
              title={`${d.date}: $${(d.cents / 100).toFixed(2)}`}
            />
          )
        })}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-navy-500">
        <span>{data[0]?.date}</span>
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </div>
  )
}
