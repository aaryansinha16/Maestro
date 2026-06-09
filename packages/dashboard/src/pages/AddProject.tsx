// Phase 4.5 / Sub 4.5.4 — onboarding wizard. Five steps:
//   1. repo URL → probe
//   2. seed context.md (editable preview)
//   3. state.md focus + initial tasks
//   4. autonomy (reuses AutonomyForm)
//   5. review → POST /api/projects/init → PR link → register
//
// If the probe finds an existing .maestro/, the wizard short-circuits to
// register-only: the repo was initialised before (or by the CLI).

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type {
  GithubProbeResponse,
  InitProjectResponse,
  RegisterProjectResponse,
  UpdateAutonomyBody,
} from '@maestro/api'
import { DEFAULT_AUTONOMY_CONFIG, type ProjectAutonomyConfig } from '@maestro/shared'
import { useApi } from '../hooks/useApi'
import { AutonomyForm } from '../components/AutonomyForm'

type Step = 'repo' | 'context' | 'state' | 'autonomy' | 'review'

export function AddProject() {
  const api = useApi()
  const navigate = useNavigate()

  const [step, setStep] = useState<Step>('repo')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Collected state across steps.
  const [repoUrl, setRepoUrl] = useState('')
  const [probe, setProbe] = useState<GithubProbeResponse | null>(null)
  const [context, setContext] = useState('')
  const [focus, setFocus] = useState('')
  const [tasksText, setTasksText] = useState('')
  const [autonomy, setAutonomy] = useState<ProjectAutonomyConfig>({
    ...DEFAULT_AUTONOMY_CONFIG,
  })
  const [initResult, setInitResult] = useState<InitProjectResponse | null>(null)
  const [registered, setRegistered] = useState(false)

  const runProbe = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.get<GithubProbeResponse>(
        `/api/github/probe?repoUrl=${encodeURIComponent(repoUrl.trim())}`,
      )
      setProbe(res)
      setContext(res.suggestedContext)
      setAutonomy((a) => ({
        ...a,
        branches: { ...a.branches, base: res.defaultBranch },
      }))
      setStep('context')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'probe failed')
    } finally {
      setBusy(false)
    }
  }

  const submitInit = async () => {
    setBusy(true)
    setError(null)
    try {
      const tasks = tasksText
        .split('\n')
        .map((t) => t.trim())
        .filter(Boolean)
      const res = await api.post<InitProjectResponse>('/api/projects/init', {
        repoUrl: repoUrl.trim(),
        focus: focus.trim(),
        tasks,
        autonomy,
        context,
        openAsPR: true,
      })
      setInitResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'init failed')
    } finally {
      setBusy(false)
    }
  }

  const submitRegister = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<RegisterProjectResponse>('/api/projects/register', {
        repoUrl: repoUrl.trim(),
      })
      setRegistered(true)
      navigate(`/projects/${encodeURIComponent(res.project.slug)}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'register failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <header>
        <Link to="/" className="text-xs text-amber-400 hover:underline">
          ← all projects
        </Link>
        <h2 className="mt-2 text-2xl font-semibold text-white">Add project</h2>
        <p className="mt-1 text-sm text-navy-300">
          Scaffolds <span className="font-mono">.maestro/</span> on a new branch via the
          GitHub API and opens a PR — no local checkout needed. Merge the PR, then
          register the project to start running sessions.
        </p>
      </header>

      <StepIndicator current={step} />

      {error ? (
        <div className="panel border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {step === 'repo' ? (
        <div className="panel space-y-4 px-5 py-5">
          <label className="block">
            <div className="mb-1 text-xs uppercase tracking-wide text-navy-400">
              GitHub repository URL
            </div>
            <input
              type="url"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/you/your-project"
              className="w-full rounded border border-navy-700 bg-navy-800 px-3 py-2 font-mono text-sm text-navy-100"
            />
          </label>
          <button
            type="button"
            disabled={busy || !/^https?:\/\/.+\/.+/.test(repoUrl.trim())}
            onClick={() => void runProbe()}
            className="rounded border border-amber-400/60 bg-amber-400/10 px-4 py-1.5 text-sm font-medium text-amber-200 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Probing…' : 'Probe repository'}
          </button>
        </div>
      ) : null}

      {step === 'context' && probe ? (
        probe.hasMaestroDir ? (
          <div className="panel space-y-4 px-5 py-5">
            <p className="text-sm text-navy-100">
              <span className="font-mono">{probe.projectName}</span> already has a{' '}
              <span className="font-mono">.maestro/</span> directory on{' '}
              <span className="font-mono">{probe.defaultBranch}</span>. Skip straight to
              registration.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void submitRegister()}
              className="rounded border border-amber-400/60 bg-amber-400/10 px-4 py-1.5 text-sm font-medium text-amber-200 transition hover:bg-amber-400/20 disabled:opacity-40"
            >
              {busy ? 'Registering…' : 'Register project'}
            </button>
          </div>
        ) : (
          <div className="panel space-y-4 px-5 py-5">
            <div className="text-sm text-navy-300">
              Seed <span className="font-mono">context.md</span> for{' '}
              <span className="font-mono text-navy-100">{probe.projectName}</span> (default
              branch <span className="font-mono">{probe.defaultBranch}</span>). Edit freely —
              the agent reads this every session.
            </div>
            <textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              rows={16}
              className="w-full rounded border border-navy-700 bg-navy-800 px-3 py-2 font-mono text-xs text-navy-100"
            />
            <WizardNav
              onBack={() => setStep('repo')}
              onNext={() => setStep('state')}
              nextDisabled={context.trim().length === 0}
            />
          </div>
        )
      ) : null}

      {step === 'state' ? (
        <div className="panel space-y-4 px-5 py-5">
          <label className="block">
            <div className="mb-1 text-xs uppercase tracking-wide text-navy-400">
              Current focus (1–3 sentences)
            </div>
            <textarea
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              rows={3}
              placeholder="What is this project working toward right now?"
              className="w-full rounded border border-navy-700 bg-navy-800 px-3 py-2 text-sm text-navy-100"
            />
          </label>
          <label className="block">
            <div className="mb-1 text-xs uppercase tracking-wide text-navy-400">
              Initial tasks (one per line, 30–60 min each)
            </div>
            <textarea
              value={tasksText}
              onChange={(e) => setTasksText(e.target.value)}
              rows={5}
              placeholder={'Fix the flaky auth test\nAdd pagination to /api/items'}
              className="w-full rounded border border-navy-700 bg-navy-800 px-3 py-2 font-mono text-sm text-navy-100"
            />
          </label>
          <WizardNav
            onBack={() => setStep('context')}
            onNext={() => setStep('autonomy')}
            nextDisabled={focus.trim().length === 0}
          />
        </div>
      ) : null}

      {step === 'autonomy' ? (
        <div className="panel">
          <header className="panel-header">
            <h3 className="font-medium text-white">Autonomy settings</h3>
            <button
              type="button"
              onClick={() => setStep('state')}
              className="text-xs text-navy-400 hover:text-amber-400 hover:underline"
            >
              back
            </button>
          </header>
          <AutonomyForm
            value={autonomy}
            submitLabel="Continue"
            onSubmit={(patch: UpdateAutonomyBody) => {
              setAutonomy((a) => ({
                ...a,
                ...patch,
                branches: { ...a.branches, ...(patch.branches ?? {}) },
                github: { ...a.github, ...(patch.github ?? {}) },
              }))
              setStep('review')
              return Promise.resolve()
            }}
          />
        </div>
      ) : null}

      {step === 'review' ? (
        <div className="panel space-y-4 px-5 py-5">
          {!initResult ? (
            <>
              <h3 className="font-medium text-white">Review</h3>
              <dl className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
                <ReviewField label="Repository" value={repoUrl} mono />
                <ReviewField label="Base branch" value={autonomy.branches.base} mono />
                <ReviewField label="Autonomy level" value={autonomy.level} />
                <ReviewField
                  label="Time budget"
                  value={`${Math.round(autonomy.timeBudget / 60)}m`}
                />
                <ReviewField
                  label="Quality gates"
                  value={autonomy.qualityGates.join(', ') || '—'}
                />
                <ReviewField
                  label="Tasks"
                  value={String(tasksText.split('\n').filter((t) => t.trim()).length)}
                />
              </dl>
              <p className="text-xs text-navy-400">
                Files to be committed on <span className="font-mono">maestro/init</span>:
                state.md, context.md, decisions.md, autonomy.json, journal/.gitkeep
              </p>
              <WizardNav
                onBack={() => setStep('autonomy')}
                onNext={() => void submitInit()}
                nextLabel={busy ? 'Opening PR…' : 'Open init PR'}
                nextDisabled={busy}
              />
            </>
          ) : (
            <>
              <h3 className="font-medium text-white">Init PR opened</h3>
              <p className="text-sm text-navy-100">
                {initResult.prUrl ? (
                  <>
                    Review and merge{' '}
                    <a
                      href={initResult.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-amber-300 hover:underline"
                    >
                      PR #{initResult.prNumber}
                    </a>{' '}
                    on GitHub, then register the project below.
                  </>
                ) : (
                  <>Files committed directly to {initResult.branch}. Register below.</>
                )}
              </p>
              <button
                type="button"
                disabled={busy || registered}
                onClick={() => void submitRegister()}
                className="rounded border border-amber-400/60 bg-amber-400/10 px-4 py-1.5 text-sm font-medium text-amber-200 transition hover:bg-amber-400/20 disabled:opacity-40"
              >
                {busy ? 'Registering…' : 'Register project'}
              </button>
              <p className="text-xs text-navy-400">
                Registration validates <span className="font-mono">.maestro/</span> on the
                default branch — merge the PR first or registration will fail.
              </p>
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}

const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'repo', label: 'Repository' },
  { key: 'context', label: 'Context' },
  { key: 'state', label: 'State' },
  { key: 'autonomy', label: 'Autonomy' },
  { key: 'review', label: 'Review' },
]

function StepIndicator({ current }: { current: Step }) {
  const idx = STEPS.findIndex((s) => s.key === current)
  return (
    <ol className="flex flex-wrap gap-2 text-xs">
      {STEPS.map((s, i) => (
        <li
          key={s.key}
          className={
            i === idx
              ? 'pill pill-amber'
              : i < idx
                ? 'pill text-success-400'
                : 'pill text-navy-400'
          }
        >
          {i + 1}. {s.label}
        </li>
      ))}
    </ol>
  )
}

function WizardNav({
  onBack,
  onNext,
  nextLabel = 'Continue',
  nextDisabled = false,
}: {
  onBack: () => void
  onNext: () => void
  nextLabel?: string
  nextDisabled?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onBack}
        className="rounded border border-navy-700 px-3 py-1 text-xs text-navy-300 transition hover:border-navy-600"
      >
        Back
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled}
        className="rounded border border-amber-400/60 bg-amber-400/10 px-3 py-1 text-xs font-medium text-amber-200 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {nextLabel}
      </button>
    </div>
  )
}

function ReviewField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-navy-400">{label}</div>
      <div className={mono ? 'font-mono text-navy-100' : 'text-navy-100'}>{value}</div>
    </div>
  )
}
