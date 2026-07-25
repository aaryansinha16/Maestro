// Project stack detection. Looks at well-known root files to figure out
// which build/test/lint commands a managed project uses, then maps each
// quality gate (test, lint, typecheck, build) to a concrete argv.
//
// Detection order matters — pnpm before npm before yarn before bun, because
// the lockfile is the most reliable signal. Python and Rust stacks are
// detected by their respective manifests.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectStack, QualityGate, QualityGateCommand } from '@maestro/shared'

interface NodePackageJson {
  scripts?: Record<string, string>
}

export interface DetectedStack {
  stack: ProjectStack
  /** Lookup: gate → argv. Missing entry means the gate can't be run. */
  gates: Partial<Record<QualityGate, QualityGateCommand>>
}

export async function detectStack(projectRoot: string): Promise<DetectedStack> {
  // Node ecosystem — read package.json scripts to be smart about commands.
  if (existsSync(join(projectRoot, 'package.json'))) {
    const manager = detectNodePackageManager(projectRoot)
    const pkg = await readPackageJson(projectRoot)
    const gates = nodeGates(manager, pkg, projectRoot)
    return { stack: manager, gates }
  }

  if (existsSync(join(projectRoot, 'pyproject.toml'))) {
    return { stack: 'python-poetry', gates: pythonGates() }
  }

  if (
    existsSync(join(projectRoot, 'requirements.txt')) ||
    existsSync(join(projectRoot, 'setup.py'))
  ) {
    return { stack: 'python-pip', gates: pythonGates() }
  }

  if (existsSync(join(projectRoot, 'Cargo.toml'))) {
    return { stack: 'rust-cargo', gates: rustGates() }
  }

  if (existsSync(join(projectRoot, 'go.mod'))) {
    return { stack: 'go-mod', gates: goGates() }
  }

  return { stack: 'unknown', gates: {} }
}

type NodeManager = 'pnpm' | 'npm' | 'yarn' | 'bun'

function detectNodePackageManager(projectRoot: string): NodeManager {
  if (existsSync(join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(projectRoot, 'yarn.lock'))) return 'yarn'
  // Bun 1.1+ writes a text `bun.lock`; older versions the binary `bun.lockb`.
  // Detect both so a Bun repo isn't misdetected as npm. ENG-16.
  if (existsSync(join(projectRoot, 'bun.lockb')) || existsSync(join(projectRoot, 'bun.lock')))
    return 'bun'
  return 'npm'
}

async function readPackageJson(projectRoot: string): Promise<NodePackageJson> {
  try {
    const raw = await readFile(join(projectRoot, 'package.json'), 'utf-8')
    return JSON.parse(raw) as NodePackageJson
  } catch {
    return {}
  }
}

function nodeGates(
  manager: NodeManager,
  pkg: NodePackageJson,
  projectRoot: string,
): DetectedStack['gates'] {
  const scripts = pkg.scripts ?? {}
  const gates: DetectedStack['gates'] = {}
  if (scripts['test']) gates['test'] = runScript(manager, 'test')
  if (scripts['lint']) gates['lint'] = runScript(manager, 'lint')
  if (scripts['typecheck']) gates['typecheck'] = runScript(manager, 'typecheck')
  else if (scripts['tsc']) gates['typecheck'] = runScript(manager, 'tsc')
  else if (existsSync(join(projectRoot, 'tsconfig.json'))) {
    gates['typecheck'] = { command: 'npx', args: ['tsc', '--noEmit'] }
  }
  if (scripts['build']) gates['build'] = runScript(manager, 'build')
  return gates
}

function runScript(manager: NodeManager, script: string): QualityGateCommand {
  switch (manager) {
    case 'pnpm':
      return { command: 'pnpm', args: ['run', script] }
    case 'yarn':
      return { command: 'yarn', args: [script] }
    case 'bun':
      return { command: 'bun', args: ['run', script] }
    default:
      return { command: 'npm', args: ['run', script] }
  }
}

function pythonGates(): DetectedStack['gates'] {
  // Conservative defaults; real projects override via context.md (Phase 1
  // we keep this simple).
  return {
    test: { command: 'pytest', args: [] },
    typecheck: { command: 'mypy', args: ['.'] },
  }
}

function rustGates(): DetectedStack['gates'] {
  return {
    test: { command: 'cargo', args: ['test'] },
    typecheck: { command: 'cargo', args: ['check'] },
    build: { command: 'cargo', args: ['build'] },
    lint: { command: 'cargo', args: ['clippy', '--', '-D', 'warnings'] },
  }
}

function goGates(): DetectedStack['gates'] {
  return {
    test: { command: 'go', args: ['test', './...'] },
    build: { command: 'go', args: ['build', './...'] },
    typecheck: { command: 'go', args: ['vet', './...'] },
  }
}
