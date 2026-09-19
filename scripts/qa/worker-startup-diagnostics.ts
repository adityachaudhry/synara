/** Native failure-path check. Creates and destroys one isolated Railway dev sandbox. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Effect, Layer } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { createRequire } from 'node:module';
const { Sandbox } = createRequire(new URL('../../apps/server/package.json', import.meta.url))('railway');
import { WorkspaceRuntime } from '../../apps/server/src/workspaceRuntime/Services/WorkspaceRuntime';
import { ProviderWorkerBroker } from '../../apps/server/src/providerWorker/Services/ProviderWorkerBroker';
import { ProviderWorkerBootstrapAuthority } from '../../apps/server/src/providerWorker/Services/ProviderWorkerBootstrapAuthority';
import { makeProviderWorkerProvisioner } from '../../apps/server/src/providerWorker/Layers/ProviderWorkerProvisioner';

assert(process.argv.includes('--run-railway-dev'), 'Pass --run-railway-dev to authorize the disposable dev sandbox');
const vars = JSON.parse(execFileSync('railway', ['variables', '-p', '2fb578c6-304e-4a97-abd4-38b3897d9030', '-e', 'dev', '-s', 'synara-gitea-dev', '--json'], { encoding: 'utf8' }));
const connection = { token: vars.SYNARA_RAILWAY_SANDBOX_TOKEN, authType: vars.SYNARA_RAILWAY_SANDBOX_AUTH_TYPE || 'project-token', environmentId: vars.SYNARA_RAILWAY_SANDBOX_ENVIRONMENT_ID };
assert.equal(connection.environmentId, '2e924ee7-34be-449d-8ffd-1da0458d482a');
const checkpoint = vars.SYNARA_PROVIDER_WORKER_TEMPLATE_CHECKPOINT;
assert(checkpoint, 'Dev worker template must be configured');
const sandbox = await Sandbox.create(checkpoint, { ...connection, networkIsolation: 'ISOLATED', idleTimeoutMinutes: 5 });
const binding = { runtimeKind: 'railway-sandbox', runtimeId: sandbox.id, lifecycleGeneration: 'diagnostic-qa', status: 'running', region: sandbox.region } as const;
const calls: string[] = [];
let processHandle: ReturnType<typeof sandbox.exec> | undefined;
const remote = <A>(run: () => PromiseLike<A>) => Effect.tryPromise(() => Promise.resolve(run()));
const runtime = {
  create: () => Effect.succeed(binding),
  exec: (_: unknown, input: {command: string; timeoutSeconds: number}) => remote(async () => {
    const result = await sandbox.exec(input.command, { timeoutSec: input.timeoutSeconds });
    if (input.command.startsWith('tail -c')) { calls.push('diagnostics'); assert(result.stdout.includes('NATIVE_STARTUP_FAILURE')); }
    return result;
  }),
  writeFile: (_: unknown, input: {path: string; data: Uint8Array; mode: number}) => remote(() => sandbox.files.write(input.path, input.data, { mode: input.mode })),
  startDurableProcess: (_: unknown, input: {command: string}) => remote(async () => {
    processHandle = sandbox.exec(input.command); const sessionName = await processHandle.sessionName; await processHandle.detach();
    return { sessionName, supervision: 'durable' };
  }),
  stopDurableProcess: () => remote(async () => { calls.push('stop'); await processHandle?.kill(); }),
  destroy: () => remote(async () => { calls.push('destroy'); await sandbox.destroy(); }),
};
const secret = 'QA_BOOTSTRAP_SECRET_MUST_BE_REDACTED';
const layer = Layer.mergeAll(NodeServices.layer,
  Layer.succeed(WorkspaceRuntime, runtime as never),
  Layer.succeed(ProviderWorkerBroker, {
    expectWorker: () => Effect.void,
    waitForConnection: () => Effect.sleep('2 seconds').pipe(Effect.andThen(Effect.fail(new Error('Intentional QA worker connection failure')))),
    retire: () => Effect.void,
  } as never),
  Layer.succeed(ProviderWorkerBootstrapAuthority, { issue: () => Effect.succeed(secret), revoke: () => Effect.void } as never));
try {
  const provisioner = await Effect.runPromise(makeProviderWorkerProvisioner({
    artifact: new TextEncoder().encode(`console.error('NATIVE_STARTUP_FAILURE ${secret}'); setInterval(() => {}, 1000);`),
    controlUrl: 'ws://127.0.0.1:1',
  }).pipe(Effect.provide(layer), Effect.scoped));
  const result = await Effect.runPromise(provisioner.start({ threadId: crypto.randomUUID() as never, lifecycleGeneration: 'diagnostic-qa' }).pipe(Effect.result));
  assert.equal(result._tag, 'Failure');
  assert.deepEqual(calls, ['diagnostics', 'stop', 'destroy']);
  console.log('PASS: real dev worker log captured before process stop and sandbox destruction');
} finally {
  if (!calls.includes('destroy')) await sandbox.destroy();
}
