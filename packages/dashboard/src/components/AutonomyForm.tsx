// Phase 4.5 / Sub 4.5.3 — structured editor for ProjectAutonomyConfig.
// Backs both the inline "Edit autonomy" toggle on ProjectDetail and the
// onboarding wizard from 4.5.4. Schedule-side fields (schedule, skipDays,
// maxSessionsPerDay, priority, scheduledEnabled) are intentionally NOT
// edited here — they go through the /api/projects/:slug/schedule
// endpoint (and the Schedule page surfaces toggles for them).

import { useEffect, useState } from 'react'
import type { UpdateAutonomyBody } from '@maestro/api'
import type { ProjectAutonomyConfig } from '@maestro/shared'

const LEVELS: ReadonlyArray<ProjectAutonomyConfig['level']> = [
  'pr-only',
  'draft-only',
  'full',
  'paused',
]
const GATES = ['test', 'lint', 'typecheck', 'build'] as const

type Gate = (typeof GATES)[number]

export interface AutonomyFormProps {
  value: ProjectAutonomyConfig
  onSubmit: (patch: UpdateAutonomyBody) => Promise<void>
  onCancel?: () => void
  /** Submit button label. Defaults to "Save". The wizard overrides this. */
  submitLabel?: string
}

interface FormState {
  level: ProjectAutonomyConfig['level']
  timeBudgetMinutes: number
  qualityGates: Set<Gate>
  branchBase: string
  branchPrefix: string
  prLabels: string  // comma-separated
  draftByDefault: boolean
  continueUntilBudget: boolean
  minTimeForContinuationMinutes: number
}

function toFormState(v: ProjectAutonomyConfig): FormState {
  return {
    level: v.level,
    timeBudgetMinutes: Math.round(v.timeBudget / 60),
    qualityGates: new Set(v.qualityGates as Gate[]),
    branchBase: v.branches.base,
    branchPrefix: v.branches.prefix,
    prLabels: v.github.prLabels.join(', '),
    draftByDefault: v.github.draftByDefault,
    continueUntilBudget: v.continueUntilBudget,
    minTimeForContinuationMinutes: Math.round(v.minTimeForContinuation / 60),
  }
}

function fromFormState(s: FormState): UpdateAutonomyBody {
  return {
    level: s.level,
    timeBudget: s.timeBudgetMinutes * 60,
    qualityGates: [...s.qualityGates].sort(),
    branches: {
      base: s.branchBase.trim(),
      prefix: s.branchPrefix.trim(),
    },
    github: {
      prLabels: s.prLabels
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean),
      draftByDefault: s.draftByDefault,
    },
    continueUntilBudget: s.continueUntilBudget,
    minTimeForContinuation: s.minTimeForContinuationMinutes * 60,
  }
}

export function AutonomyForm({
  value,
  onSubmit,
  onCancel,
  submitLabel = 'Save',
}: AutonomyFormProps) {
  const [state, setState] = useState<FormState>(() => toFormState(value))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setState(toFormState(value))
  }, [value])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (state.timeBudgetMinutes < 1) {
      setError('Time budget must be at least 1 minute.')
      return
    }
    if (state.minTimeForContinuationMinutes < 1) {
      setError('Min time for continuation must be at least 1 minute.')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      await onSubmit(fromFormState(state))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to save')
    } finally {
      setSubmitting(false)
    }
  }

  const toggleGate = (gate: Gate) => {
    setState((s) => {
      const next = new Set(s.qualityGates)
      if (next.has(gate)) next.delete(gate)
      else next.add(gate)
      return { ...s, qualityGates: next }
    })
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-4 px-5 py-4 md:grid-cols-2">
      <Field label="Autonomy level">
        <select
          value={state.level}
          onChange={(e) =>
            setState((s) => ({ ...s, level: e.target.value as ProjectAutonomyConfig['level'] }))
          }
          className="w-full rounded border border-navy-700 bg-navy-800 px-2 py-1 text-sm text-navy-100"
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Time budget (minutes)">
        <input
          type="number"
          min={1}
          max={240}
          value={state.timeBudgetMinutes}
          onChange={(e) =>
            setState((s) => ({ ...s, timeBudgetMinutes: Number(e.target.value) }))
          }
          className="w-full rounded border border-navy-700 bg-navy-800 px-2 py-1 text-sm text-navy-100"
        />
      </Field>

      <Field label="Quality gates" className="md:col-span-2">
        <div className="flex flex-wrap gap-3">
          {GATES.map((g) => (
            <label key={g} className="flex items-center gap-2 text-sm text-navy-100">
              <input
                type="checkbox"
                checked={state.qualityGates.has(g)}
                onChange={() => toggleGate(g)}
              />
              {g}
            </label>
          ))}
        </div>
      </Field>

      <Field label="Base branch">
        <input
          type="text"
          value={state.branchBase}
          onChange={(e) => setState((s) => ({ ...s, branchBase: e.target.value }))}
          className="w-full rounded border border-navy-700 bg-navy-800 px-2 py-1 font-mono text-sm text-navy-100"
        />
      </Field>

      <Field label="Branch prefix">
        <input
          type="text"
          value={state.branchPrefix}
          onChange={(e) => setState((s) => ({ ...s, branchPrefix: e.target.value }))}
          className="w-full rounded border border-navy-700 bg-navy-800 px-2 py-1 font-mono text-sm text-navy-100"
        />
      </Field>

      <Field label="PR labels (comma-separated)" className="md:col-span-2">
        <input
          type="text"
          value={state.prLabels}
          onChange={(e) => setState((s) => ({ ...s, prLabels: e.target.value }))}
          placeholder="maestro, automation"
          className="w-full rounded border border-navy-700 bg-navy-800 px-2 py-1 text-sm text-navy-100"
        />
      </Field>

      <Field label="Open PRs as draft by default">
        <label className="flex items-center gap-2 text-sm text-navy-100">
          <input
            type="checkbox"
            checked={state.draftByDefault}
            onChange={(e) =>
              setState((s) => ({ ...s, draftByDefault: e.target.checked }))
            }
          />
          {state.draftByDefault ? 'draft' : 'open'}
        </label>
      </Field>

      <Field label="Continue until budget exhausted">
        <label className="flex items-center gap-2 text-sm text-navy-100">
          <input
            type="checkbox"
            checked={state.continueUntilBudget}
            onChange={(e) =>
              setState((s) => ({ ...s, continueUntilBudget: e.target.checked }))
            }
          />
          {state.continueUntilBudget ? 'enabled' : 'disabled'}
        </label>
      </Field>

      <Field label="Min time for continuation (minutes)">
        <input
          type="number"
          min={1}
          max={240}
          value={state.minTimeForContinuationMinutes}
          onChange={(e) =>
            setState((s) => ({
              ...s,
              minTimeForContinuationMinutes: Number(e.target.value),
            }))
          }
          className="w-full rounded border border-navy-700 bg-navy-800 px-2 py-1 text-sm text-navy-100"
        />
      </Field>

      {error ? (
        <div className="md:col-span-2 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      ) : null}

      <div className="md:col-span-2 flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded border border-amber-400/60 bg-amber-400/10 px-3 py-1 text-xs font-medium text-amber-200 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? 'Saving…' : submitLabel}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded border border-navy-700 px-3 py-1 text-xs text-navy-300 transition hover:border-navy-600"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  )
}

function Field({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={className}>
      <div className="mb-1 text-xs uppercase tracking-wide text-navy-400">{label}</div>
      {children}
    </div>
  )
}
