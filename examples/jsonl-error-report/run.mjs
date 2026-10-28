import { mkdir, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv.length !== 3) throw new Error('Usage: node run.mjs <new-target-directory>');
const target = resolve(process.argv[2]);
// Non-recursive creation atomically rejects an existing target before any writes.
await mkdir(target);
const projectRoot = join(target, 'repo');
const stateDir = join(target, 'state');
await cp(join(here, 'seed'), projectRoot, { recursive: true });
function git(...args) {
  console.log(`$ git ${args.join(' ')}`);
  const result = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) throw new Error(`git exited ${result.status}: ${result.error ?? ''}`);
}
git('init', '-b', 'autopilot/example-jsonl');
git('config', 'user.name', 'Example Runner');
git('config', 'user.email', 'example@example.invalid');
git('add', '.');
git('commit', '-m', 'Seed JSONL error report');
const { createAppServices, createStoreBackedAppService, resolveStorePath, resolveWorktreesDir, runCli } = await import('../../packages/cli/dist/index.js');
const options = { projectRoot, stateDir, agentTimeoutMs: 120000, maxParallelism: 1 };
async function servicesFactory(request) {
  const app = await createAppServices(options, {}, request);
  return createStoreBackedAppService({
    storePath: resolveStorePath(options), projectRoot, store: app.store,
    orchestrator: app.orchestrator, recovery: app.recovery,
    executionClaimRecovery: app.executionClaimRecovery, integrationRecovery: app.integrationRecovery,
    worktreeRecovery: app.worktreeRecovery, agents: app.agents, scheduler: app.scheduler,
    maxParallelism: app.maxParallelism, runner: app.runner, worktreesDir: resolveWorktreesDir(options),
    configuration: app.configuration, configurationError: app.configurationError,
    analyzeRepository: app.analyzeRepository, planRepository: app.planRepository,
  });
}
let failed = false;
for (const args of [['init'], ['tasks', 'add', join(projectRoot, 'task.json')], ['run', '--parallel', '1'], ['status'], ['inspect', 'JSONL1']]) {
  console.log(`$ agentic ${args.join(' ')}`);
  const code = await runCli(args, { servicesFactory });
  console.log(`exit: ${code}`);
  if (code !== 0) failed = true;
  if (code !== 0 && (args[0] === 'init' || args[0] === 'tasks')) break;
}
const service = await servicesFactory();
try {
  const inspection = await service.inspect('JSONL1');
  const queue = inspection?.integrationQueue ?? [];
  console.log(`assertion: task=${inspection?.task.status ?? 'missing'} queue=${queue.map((entry) => entry.status).join(',') || 'empty'}`);
  if (inspection?.task.status !== 'DONE' || queue.length !== 1 || queue[0].status !== 'COMPLETED') failed = true;
} finally {
  await service.close();
}
git('log', '--oneline', '--decorate', '-3');
git('status', '--short', '--branch');
git('worktree', 'list');
if (failed) process.exitCode = 1;
