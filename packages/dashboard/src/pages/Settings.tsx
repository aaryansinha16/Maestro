import { useEffect, useState } from 'react'
import { useApi } from '../hooks/useApi'

interface SettingsData {
  version: string
  developerName: string
  developerGithubUsername: string | null
  dataDir: string
  timezone: string
  authEnabled: boolean
  corsEnabled: boolean
  githubConfigured: boolean
  telegramConfigured: boolean
  claudeTokenAuth: boolean
  monthlyBudgetUsd: number
  sessionBudgetUsd: number
  maxParallel: number
  briefingTime: string
}

export function Settings() {
  const api = useApi()
  const [data, setData] = useState<SettingsData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<SettingsData>('/api/settings')
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
    <section className="mx-auto max-w-3xl space-y-6">
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-amber-500">Instance</p>
        <h2 className="mt-1 text-2xl font-semibold text-white">Settings</h2>
        <p className="mt-1 text-sm text-navy-300">
          This instance's configuration, from environment variables — edit your{' '}
          <span className="font-mono">.env</span> and restart to change them. Per-project autonomy
          is edited on each project's page.
        </p>
      </header>

      {error ? (
        <div className="panel border-danger/40 bg-danger/10 px-5 py-4 text-sm text-danger">
          {error}
        </div>
      ) : !data ? (
        <div className="panel h-40 animate-pulse" />
      ) : (
        <>
          <div className="panel divide-y divide-navy-700/70">
            <Row label="Version" value={data.version} />
            <Row
              label="Developer"
              value={`${data.developerName}${
                data.developerGithubUsername ? ` (@${data.developerGithubUsername})` : ''
              }`}
            />
            <Row label="Data dir" value={data.dataDir} mono />
            <Row label="Timezone" value={data.timezone} />
            <Row label="Briefing time" value={data.briefingTime} />
          </div>

          <div className="panel divide-y divide-navy-700/70">
            <Flag
              label="Dashboard auth"
              on={data.authEnabled}
              onText="enabled"
              offText="OPEN — set MAESTRO_AUTH_USER/PASSWORD"
              warnOff
            />
            <Flag
              label="GitHub token"
              on={data.githubConfigured}
              onText="configured"
              offText="missing — PRs disabled"
              warnOff
            />
            <Flag
              label="Claude token auth"
              on={data.claudeTokenAuth}
              onText="CLAUDE_CODE_OAUTH_TOKEN set"
              offText="using stored login / keychain"
            />
            <Flag
              label="Telegram briefings"
              on={data.telegramConfigured}
              onText="configured"
              offText="not configured"
            />
            <Flag
              label="CORS"
              on={data.corsEnabled}
              onText="allow-origin set"
              offText="same-origin only"
            />
          </div>

          <div className="panel divide-y divide-navy-700/70">
            <Row label="Monthly budget" value={`$${data.monthlyBudgetUsd}`} />
            <Row
              label="Per-session cap"
              value={data.sessionBudgetUsd > 0 ? `$${data.sessionBudgetUsd}` : 'disabled'}
            />
            <Row label="Max parallel sessions" value={String(data.maxParallel)} />
          </div>
        </>
      )}
    </section>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
      <span className="text-navy-300">{label}</span>
      <span className={`truncate text-navy-100 ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
    </div>
  )
}

function Flag({
  label,
  on,
  onText,
  offText,
  warnOff,
}: {
  label: string
  on: boolean
  onText: string
  offText: string
  warnOff?: boolean
}) {
  const color = on ? 'text-success-400' : warnOff ? 'text-amber-300' : 'text-navy-400'
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
      <span className="text-navy-300">{label}</span>
      <span className={color}>{on ? `✓ ${onText}` : `• ${offText}`}</span>
    </div>
  )
}
