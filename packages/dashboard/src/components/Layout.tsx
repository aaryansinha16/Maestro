import { NavLink, Outlet } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import { useApi } from '../hooks/useApi'
import type { HealthResponse } from '@maestro/api'

interface ClaudeHealth {
  installed: boolean
  version: string | null
  authenticated: boolean | null
  credentialsAt: string | null
  configDir: string
}

interface NavItem {
  to: string
  label: string
  exact?: boolean
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', exact: true },
  { to: '/sessions', label: 'Sessions' },
  { to: '/prs', label: 'Pull Requests' },
  { to: '/schedule', label: 'Schedule' },
  { to: '/queue', label: 'Queue' },
  { to: '/costs', label: 'Costs' },
  { to: '/settings', label: 'Settings' },
]

export function Layout() {
  const { setHealth, health } = useStore()
  const api = useApi()
  const [claude, setClaude] = useState<ClaudeHealth | null>(null)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const res = await api.get<HealthResponse>('/api/health')
        if (!cancelled) setHealth(res)
      } catch {
        if (!cancelled) setHealth(null)
      }
    }
    void tick()
    const id = window.setInterval(tick, 15_000)
    // Claude health is slow-moving — probe once per mount.
    void api
      .get<ClaudeHealth>('/api/health/claude')
      .then((res) => {
        if (!cancelled) setClaude(res)
      })
      .catch(() => {
        /* endpoint unavailable — banner stays hidden */
      })
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [api, setHealth])

  const claudeWarning =
    claude && (!claude.installed || claude.authenticated === false)
      ? !claude.installed
        ? 'Claude Code CLI is not installed on the conductor host — sessions cannot run. See docs/DEPLOYMENT.md.'
        : `Claude Code is installed but not authenticated (no credentials under ${claude.configDir}). Run \`claude /login\` on the conductor host.`
      : null

  return (
    <div className="flex h-full bg-navy-900 text-navy-100">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-navy-700/60 bg-navy-950/60 px-4 py-6 md:flex">
        <BrandMark />
        <nav className="mt-8 flex flex-col gap-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.exact}
              className={({ isActive }) =>
                `nav-link${isActive ? ' nav-link-active' : ''}`
              }
            >
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto pt-6 text-xs text-navy-300">
          <p>Phase 0 — foundation</p>
          <p className="mt-1 text-navy-400">v0.0.0</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-navy-700/60 bg-navy-900/80 px-6 py-4 backdrop-blur">
          <div>
            <h1 className="font-mono text-sm font-medium tracking-wide text-navy-200">
              maestro
            </h1>
            <p className="text-xs text-navy-400">Conductor for your codebases</p>
          </div>
          <StatusIndicator health={health} />
        </header>
        {claudeWarning ? (
          <div className="border-b border-warning/40 bg-warning/10 px-6 py-2 text-sm text-warning">
            {claudeWarning}
          </div>
        ) : null}
        <main className="flex-1 overflow-y-auto px-6 py-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function BrandMark() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-9 w-9 place-items-center rounded-lg border border-amber-700/40 bg-amber-900/20 text-amber-400">
        <svg width="18" height="18" viewBox="0 0 64 64" aria-hidden>
          <path
            d="M16 46V18l8 12 8-12 8 12 8-12v28"
            stroke="currentColor"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </span>
      <div>
        <p className="font-semibold tracking-wide">Maestro</p>
        <p className="text-xs text-navy-400">aaryansinha</p>
      </div>
    </div>
  )
}

function StatusIndicator({ health }: { health: HealthResponse | null }) {
  if (!health) {
    return (
      <span className="pill" aria-live="polite">
        <span className="h-2 w-2 rounded-full bg-danger" />
        conductor offline
      </span>
    )
  }
  return (
    <span className="pill pill-success" aria-live="polite">
      <span className="h-2 w-2 rounded-full bg-success-500" />
      conductor up · {Math.floor(health.uptimeSeconds)}s
    </span>
  )
}
