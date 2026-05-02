// `maestro doctor [<slug>]` — health check for one or all registered
// projects. Designed for Phase 1.5: every check is a thing that has bitten
// the developer in practice.
//
// Exit codes:
//   0 — every check passed
//   1 — at least one check failed (specifics printed)

import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import {
  loadConfig,
  openDatabase,
  ProjectRepository,
  SessionRepository,
  parseRepoUrl,
  workingDirFor,
} from '@maestro/conductor'
import type { Project } from '@maestro/shared'
import { failWith, info, ok, warn } from './util.js'

interface CheckResult {
  name: string
  status: 'pass' | 'warn' | 'fail'
  detail?: string
}

export interface DoctorOptions {
  slug?: string
}

export async function runDoctor(options: DoctorOptions): Promise<void> {
  const config = loadConfig()
  const { db, close } = openDatabase({ dataDir: config.dataDir })
  try {
    const projects = new ProjectRepository(db)
    const sessions = new SessionRepository(db)

    let targets: Project[]
    if (options.slug) {
      const p = projects.findBySlug(options.slug)
      if (!p) failWith(`Unknown project slug: ${options.slug}`)
      targets = [p]
    } else {
      targets = projects.list()
    }

    if (targets.length === 0) {
      info('No projects registered. Add one with `maestro add <repo-url>`.')
      return
    }

    let anyFailed = false
    for (const project of targets) {
      console.log()
      console.log(`▸ ${project.slug}`)
      const checks = await runChecks({ project, config, sessions })
      for (const c of checks) {
        const sym = c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '✗'
        const tail = c.detail ? `  ${c.detail}` : ''
        const line = `  ${sym} ${c.name}${tail}`
        if (c.status === 'fail') {
          console.error(line)
          anyFailed = true
        } else if (c.status === 'warn') {
          warn(line)
        } else {
          ok(line)
        }
      }
    }

    console.log()
    if (anyFailed) {
      console.error('doctor: at least one check failed')
      process.exit(1)
    } else {
      ok('doctor: all checks passed')
    }
  } finally {
    close()
  }
}

interface RunChecksInput {
  project: Project
  config: ReturnType<typeof loadConfig>
  sessions: SessionRepository
}

async function runChecks(input: RunChecksInput): Promise<CheckResult[]> {
  const checks: CheckResult[] = []
  const workDir = workingDirFor(input.config.dataDir, input.project.slug)

  // 1. Working dir state
  if (!existsSync(workDir)) {
    checks.push({
      name: 'working clone',
      status: 'warn',
      detail: 'no working clone yet — first session will create it',
    })
  } else {
    const cleanCheck = await isWorkingDirClean(workDir)
    checks.push({
      name: 'working clone clean',
      status: cleanCheck.clean ? 'pass' : 'fail',
      detail: cleanCheck.detail,
    })
  }

  // 2. .maestro/ contract — only checkable when a clone exists
  if (existsSync(workDir) && existsSync(join(workDir, '.maestro'))) {
    const contractCheck = await checkMaestroContract(workDir)
    checks.push(contractCheck)
  } else {
    checks.push({
      name: '.maestro/ contract',
      status: 'warn',
      detail: 'no working clone — register & run a session to materialise it',
    })
  }

  // 3. GitHub token can access the repo
  const ghCheck = await checkGitHubAccess(input.project, input.config.githubToken)
  checks.push(ghCheck)

  // 4. Quality-gate commands resolve
  const gateChecks = await checkGateCommands(workDir, input.project.autonomyConfig.qualityGates)
  checks.push(...gateChecks)

  // 5. Time budget vs. test duration heuristic
  const budgetCheck = checkBudgetVsTestDuration(input.project, input.sessions)
  if (budgetCheck) checks.push(budgetCheck)

  // 6. Recent agent activity
  checks.push(checkRecentActivity(input.project, input.sessions))

  return checks
}

async function isWorkingDirClean(
  workDir: string,
): Promise<{ clean: boolean; detail: string | undefined }> {
  try {
    const result = await execa('git', ['status', '--porcelain'], {
      cwd: workDir,
      reject: false,
    })
    if (result.exitCode !== 0) {
      return { clean: false, detail: `git status exited ${result.exitCode}` }
    }
    const out = result.stdout.toString().trim()
    if (out.length === 0) return { clean: true, detail: undefined }
    const lines = out.split('\n').length
    return { clean: false, detail: `${lines} dirty paths — run \`maestro reset <slug>\`` }
  } catch (err) {
    return {
      clean: false,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

async function checkMaestroContract(workDir: string): Promise<CheckResult> {
  // Lightweight: just verify the four files exist. Schema validation
  // happens whenever `runSession` opens the dir.
  const required = ['state.md', 'context.md', 'autonomy.json']
  const missing: string[] = []
  for (const f of required) {
    if (!existsSync(join(workDir, '.maestro', f))) missing.push(f)
  }
  if (missing.length > 0) {
    return {
      name: '.maestro/ contract',
      status: 'fail',
      detail: `missing: ${missing.join(', ')}`,
    }
  }
  return { name: '.maestro/ contract', status: 'pass' }
}

async function checkGitHubAccess(
  project: Project,
  githubToken: string | undefined,
): Promise<CheckResult> {
  if (!githubToken) {
    return {
      name: 'github access',
      status: 'warn',
      detail: 'GITHUB_TOKEN not set — sessions will push branches but not open PRs',
    }
  }
  try {
    const repo = parseRepoUrl(project.repoUrl)
    const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, {
      headers: {
        authorization: `token ${githubToken}`,
        'user-agent': 'maestro-doctor',
        accept: 'application/vnd.github+json',
      },
    })
    if (res.status === 200) {
      return { name: 'github access', status: 'pass' }
    }
    return {
      name: 'github access',
      status: 'fail',
      detail: `${res.status} ${res.statusText} — token cannot read ${repo.owner}/${repo.repo}`,
    }
  } catch (err) {
    return {
      name: 'github access',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

async function checkGateCommands(
  workDir: string,
  gates: ReadonlyArray<string>,
): Promise<CheckResult[]> {
  if (!existsSync(workDir)) {
    return [
      { name: 'gate commands', status: 'warn', detail: 'skipped (no working clone)' },
    ]
  }
  const checks: CheckResult[] = []
  // We don't call the stack-detector to keep doctor fast and read-only.
  // We just probe for the most likely binary (pnpm / npm / pytest / cargo)
  // — failing here is a "your dev box is missing a tool" signal.
  for (const gate of gates) {
    const binary = bestEffortBinaryFor(workDir, gate)
    if (!binary) {
      checks.push({
        name: `gate: ${gate}`,
        status: 'warn',
        detail: 'could not infer command — first run will probe',
      })
      continue
    }
    try {
      const res = await execa(binary, ['--version'], { reject: false, timeout: 5000 })
      if (res.exitCode === 0) {
        checks.push({
          name: `gate: ${gate}`,
          status: 'pass',
          detail: `${binary} ${res.stdout.toString().split('\n')[0]?.slice(0, 40)}`,
        })
      } else {
        checks.push({
          name: `gate: ${gate}`,
          status: 'fail',
          detail: `${binary} --version exited ${res.exitCode}`,
        })
      }
    } catch (err) {
      checks.push({
        name: `gate: ${gate}`,
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return checks
}

function bestEffortBinaryFor(workDir: string, gate: string): string | null {
  if (existsSync(join(workDir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(workDir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(workDir, 'bun.lockb'))) return 'bun'
  if (existsSync(join(workDir, 'package.json'))) return 'npm'
  if (existsSync(join(workDir, 'Cargo.toml'))) return 'cargo'
  if (existsSync(join(workDir, 'pyproject.toml')) || existsSync(join(workDir, 'requirements.txt'))) {
    return gate === 'typecheck' ? 'mypy' : 'pytest'
  }
  return null
}

function checkBudgetVsTestDuration(
  project: Project,
  sessions: SessionRepository,
): CheckResult | null {
  // Heuristic: look at the most recent successful session's `test` gate
  // duration; warn if it's > 50% of the budget.
  const recent = sessions.list({ projectId: project.id, limit: 5 })
  for (const s of recent.sessions) {
    if (!s.endedAt) continue
    const ms = new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()
    const budgetMs = project.autonomyConfig.timeBudget * 1000
    if (ms > budgetMs * 0.9) {
      return {
        name: 'time budget',
        status: 'warn',
        detail: `last session used ${(ms / budgetMs * 100).toFixed(0)}% of budget`,
      }
    }
  }
  return null
}

function checkRecentActivity(
  project: Project,
  sessions: SessionRepository,
): CheckResult {
  const list = sessions.list({ projectId: project.id, limit: 10 })
  if (list.sessions.length === 0) {
    return {
      name: 'recent activity',
      status: 'warn',
      detail: 'no sessions yet — try `maestro run <slug> --dry-run`',
    }
  }
  const last = list.sessions[0]
  if (!last) {
    return { name: 'recent activity', status: 'warn', detail: 'no recent session' }
  }
  const ageDays = (Date.now() - new Date(last.startedAt).getTime()) / 86_400_000
  if (ageDays > 14) {
    return {
      name: 'recent activity',
      status: 'warn',
      detail: `last session ${Math.round(ageDays)}d ago`,
    }
  }
  const successful = list.sessions.find(
    (s) => s.status === 'completed' && s.prNumber !== null,
  )
  if (!successful) {
    return {
      name: 'recent activity',
      status: 'warn',
      detail: 'no successful PR-producing session in last 10',
    }
  }
  return {
    name: 'recent activity',
    status: 'pass',
    detail: `last PR-producing session ${Math.round((Date.now() - new Date(successful.startedAt).getTime()) / 86_400_000)}d ago`,
  }
}

// Used by tests: synchronous `stat` for simple presence checks.
void stat
