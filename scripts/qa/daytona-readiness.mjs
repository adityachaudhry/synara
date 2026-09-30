/** Real dev-only chats and native warm-pool claims. No production or canonical Git writes. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { availableDaytonaContainerTargets } from '../../apps/server/src/workspaceRuntime/daytonaRegions.ts';
import { getUnaryRpcCapacityRetryDelayMs } from '../../apps/web/src/lib/expensiveReadRetry.ts';
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { Daytona } = await import(require.resolve('@daytona/sdk'));
const { default: WebSocket } = await import(require.resolve('ws'));
assert(process.argv.includes('--run-dev'), 'Pass --run-dev for real, disposable dev trials');
const model = process.argv.find(x => x.startsWith('--model='))?.slice(8) ?? 'anthropic/claude-opus-5';
assert(/^[a-z0-9-]+\/[a-zA-Z0-9._:/-]+$/u.test(model), 'Use a provider-qualified Pi model slug');
const models = process.argv.find(x => x.startsWith('--models='))?.slice(9).split(',') ?? [model];
assert(models.length > 0 && models.every(x => /^[a-z0-9-]+\/[a-zA-Z0-9._:/-]+$/u.test(x)), 'Use provider-qualified Pi model slugs');
const prepareMs = Number(process.argv.find(x => x.startsWith('--prepare-ms='))?.slice(13) ?? 0);
assert(Number.isInteger(prepareMs) && prepareMs >= 0 && prepareMs <= 90000);
const count = Number(process.argv.find(x => x.startsWith('--count='))?.split('=')[1] ?? 4);
assert(Number.isInteger(count) && count > 0 && count <= 98);
const coldBurst = Number(process.argv.find(x => x.startsWith('--cold-burst='))?.split('=')[1] ?? count);
assert(Number.isInteger(coldBurst) && coldBurst > 0 && coldBurst <= count);
const root = path.resolve(process.argv.find(x => x.startsWith('--output='))?.slice(9) ?? 'output/daytona-readiness');
mkdirSync(root, { recursive: true });
const vars = JSON.parse(execFileSync('railway', ['variable', 'list', '--json', '-p', '2fb578c6-304e-4a97-abd4-38b3897d9030', '-e', 'dev', '-s', 'synara-gitea-dev'], { encoding: 'utf8' }));
assert.equal(vars.SYNARA_WORKSPACE_RUNTIME, 'daytona');
const available = await availableDaytonaContainerTargets({ apiKey: vars.SYNARA_DAYTONA_API_KEY, apiUrl: vars.SYNARA_DAYTONA_API_URL });
const target = [vars.SYNARA_DAYTONA_TARGET, vars.SYNARA_DAYTONA_FALLBACK_TARGET].find(x => x && available.has(x));
assert(target, 'No configured region is executable');
const snapshot = target === vars.SYNARA_DAYTONA_TARGET ? vars.SYNARA_DAYTONA_SNAPSHOT : vars.SYNARA_DAYTONA_FALLBACK_SNAPSHOT;
assert(snapshot, 'Selected regional image is absent');
const origin = 'https://synara-gitea-dev-dev-6df3.up.railway.app';
const runId = randomUUID();
const cleanupPath = process.argv.find(x => x.startsWith('--cleanup-from='))?.slice(15);
const cleanupSource = cleanupPath ? JSON.parse(readFileSync(cleanupPath, 'utf8')) : undefined;
assert(!cleanupSource || cleanupSource.projects.every(p => /^external-[a-f0-9-]+$/.test(p.id)) && cleanupSource.runId, 'Cleanup requires saved QA ownership evidence');
const evidence = { checkedAt: new Date().toISOString(), runId, count, coldBurstSize: coldBurst, config: { preferredTarget: vars.SYNARA_DAYTONA_TARGET, target, snapshot, maxActive: vars.SYNARA_DAYTONA_MAX_ACTIVE_SANDBOXES, model, models, prepareMs }, trials: [], cleanup: [] };
const save = () => writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
const http = async (route, token, body, method = 'POST') => {
  const r = await fetch(origin + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw Error(route + ' HTTP ' + r.status);
  return r.json();
};
const d = new Daytona({ apiKey: vars.SYNARA_DAYTONA_API_KEY, apiUrl: vars.SYNARA_DAYTONA_API_URL, target });
const before = new Set();
for await (const s of d.list({ labels: { 'synara-managed': 'true' } })) before.add(s.id);
const fixtures = [];
const projects = [];
const createdThreads = new Set();
const ownedByThread = new Map();
const collectOwnedWorkers = () => {
  const logs = execFileSync('railway', ['logs', '-p', '2fb578c6-304e-4a97-abd4-38b3897d9030', '-e', 'dev', '-s', 'synara-gitea-dev', '--since', evidence.checkedAt, '--lines', '5000', '--filter', 'provider.operation', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const rows = [];
  const threadByGeneration = new Map();
  for (const line of logs.split('\n')) {
    try {
      const message = JSON.parse(line).message;
      const row = JSON.parse(message.slice(message.indexOf('{')));
      rows.push(row);
      const thread = row.threadId ?? row.workerThreadId;
      if (row.lifecycleGeneration && fixtures.some(f => f.threadId === thread)) threadByGeneration.set(row.lifecycleGeneration, thread);
    } catch {} // Structured QA ownership only; other log lines do not establish it.
  }
  for (const row of rows) {
      const thread = row.threadId ?? row.workerThreadId ?? threadByGeneration.get(row.lifecycleGeneration);
      if (row.sandboxId && fixtures.some(f => f.threadId === thread)) {
        if (!ownedByThread.has(thread)) ownedByThread.set(thread, new Set());
        ownedByThread.get(thread).add(row.sandboxId);
      }
  }
  evidence.ownedByThread = Object.fromEntries([...ownedByThread].map(([thread, ids]) => [thread, [...ids]])); save();
};
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
let command;
const clients = new Map();
let pool;
let ownedPool = false;
try {
  const existing = await d.warmPool.list();
  pool = existing.find(x => x.snapshot === snapshot && x.target === target);
  if (!pool && process.argv.includes('--pool')) { pool = await d.warmPool.create({ snapshot, pool: 2, target }); ownedPool = true; }
  if (pool) {
    const begin = Date.now();
    while (pool.currentSize < pool.pool && !pool.errorReason && Date.now() - begin < 180000) {
      await new Promise(r => setTimeout(r, 3000));
      pool = (await d.warmPool.list()).find(x => x.id === pool.id);
      assert(pool, 'Pool disappeared');
    }
    evidence.pool = { id: pool.id, snapshot: pool.snapshot, target: pool.target, pool: pool.pool, currentSize: pool.currentSize, errorReason: pool.errorReason, fillMs: Date.now() - begin };
    console.log(JSON.stringify({ phase: 'pool', ...evidence.pool })); save();
    assert(!pool.errorReason && pool.currentSize === pool.pool, 'Warm pool did not become ready');
  }
  const companies = ['chipsage', 'amorphiq', 'ansatz-labs', 'abraxas'];
  if (cleanupSource) {
    projects.push(...cleanupSource.projects);
    fixtures.push(...(cleanupSource.fixtures ?? []));
    evidence.cleanupSourceRunId = cleanupSource.runId;
  } else for (const company of companies.slice(0, Math.min(count, companies.length))) {
    const r = await http('/api/external/projects/resolve', vars.SYNARA_EXTERNAL_AUTH_SECRET, { externalKey: 'daytona-readiness:' + runId + ':' + company, name: 'QA Daytona ' + company + ' ' + runId.slice(0, 8), repositoryBinding: { kind: 'git-subdirectory', origin: vars.SYNARA_GITEA_ORIGIN, owner: vars.SYNARA_GITEA_OWNER, repository: vars.SYNARA_GITEA_REPOSITORY, ref: 'main', path: 'companies/' + company } });
    projects.push({ id: r.projectId, company });
  }
  evidence.projects = projects; save();
  const session = await http('/api/auth/external/session', vars.SYNARA_EXTERNAL_AUTH_SECRET, { subject: 'daytona-readiness-' + runId, email: 'daytona-readiness@glasswing.invalid', allowedProjectIds: projects.map(p => p.id), expiresAt: new Date(Date.now() + 840000).toISOString(), nonce: randomUUID() });
  const negotiated = await fetch(origin + '/ws/negotiate?x-synara-client-build=0.7.3&x-synara-protocol-epoch=1&x-synara-protocol-min-revision=1&x-synara-protocol-max-revision=1').then(r => r.json());
  // One independent browser connection per company, sharing no request ledger.
  for (const project of projects) {
    const ticket = await http('/api/auth/ws-token', session.sessionToken);
    const ws = new WebSocket(origin.replace('https:', 'wss:') + '/ws?' + new URLSearchParams({ wsToken: ticket.token, 'x-synara-client-build': '0.7.3', 'x-synara-protocol-epoch': '1', 'x-synara-protocol-revision': '1', 'x-synara-server-instance': negotiated.serverInstanceId }), { headers: { Origin: 'https://glasswing-web-dev-0e4d.up.railway.app' } });
    let sequence = 0;
    const pending = new Map();
    ws.on('message', raw => { for (const x of [JSON.parse(String(raw))].flat()) {
      if (x._tag === 'Ping') ws.send(JSON.stringify({ _tag: 'Pong' }));
      if (x._tag === 'Chunk') ws.send(JSON.stringify({ _tag: 'Ack', requestId: x.requestId }));
      if (x._tag === 'Exit') { const p = pending.get(String(x.requestId)); if (p) { pending.delete(String(x.requestId)); clearTimeout(p.timer); const failure = x.exit.cause?.find(c => c._tag === 'Fail')?.error; x.exit._tag === 'Success' ? p.resolve(x.exit.value) : p.reject(Object.assign(Error(JSON.stringify(x.exit).slice(0, 1500)), { code: failure?.code, retryable: failure?.retryable, retryAfterMs: failure?.retryAfterMs })); } }
    } });
    const rpcOnce = (tag, payload) => new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) { reject(Error('QA client disconnected')); return; }
      const id = String(++sequence); const timer = setTimeout(() => { pending.delete(id); reject(Error('RPC deadline: ' + tag)); }, 30000);
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }));
    });
    const rpc = async (tag, payload) => {
      for (let attempt = 0; ; attempt++) {
        try { return await rpcOnce(tag, payload); }
        catch (error) {
          // Match wsTransport: only explicit pre-handler capacity rejection is safe
          // to retry. The same commandId/payload is retained; no timeout/model retry.
          const delay = getUnaryRpcCapacityRetryDelayMs(error, attempt);
          if (delay === null) throw error;
          const counts = evidence.capacityRetriesByMethod ??= {};
          counts[tag] = (counts[tag] ?? 0) + 1;
          if (tag === 'orchestration.getThreadDetailSnapshot') evidence.snapshotReadRetries = (evidence.snapshotReadRetries ?? 0) + 1;
          save(); await new Promise(r => setTimeout(r, delay));
        }
      }
    };
    clients.set(project.id, { ws, rpc });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  }
  evidence.websocketClientCount = clients.size; save();
  const clientFor = data => {
    const projectId = data.projectId ?? fixtures.find(f => f.threadId === data.threadId)?.projectId;
    const client = clients.get(projectId);
    assert(client, 'QA request has no owned company client');
    return client;
  };
  const rpc = (tag, payload) => clientFor(payload).rpc(tag, payload);
  command = data => clientFor(data).rpc('orchestration.dispatchCommand', { commandId: randomUUID(), createdAt: new Date().toISOString(), ...data });
  if (!cleanupSource) {
  const catalog = await clients.values().next().value.rpc('provider.listModels', { provider: 'pi' });
  assert(models.every(model => catalog.models.some(entry => entry.slug === model)), 'Every selected model must be in actual Pi discovery');
  evidence.selectedModels = catalog.models.filter(entry => models.includes(entry.slug)); save();
  for (let i = 0; i < count; i++) {
    const project = projects[count >= 25 && i < 10 ? 0 : i % projects.length];
    const f = { threadId: randomUUID(), projectId: project.id, company: project.company, model: models[i % models.length], marker: randomUUID(), note: 'analysis/daytona-qa-' + runId + '-' + i + '.txt' };
    fixtures.push(f); evidence.fixtures = fixtures; save();
  }
  if (prepareMs > 0) {
    const started = Date.now();
    evidence.preparations = await Promise.all(fixtures.map(async f => ({ threadId: f.threadId,
      ...await rpc('provider.prepareWorkspace', { projectId: f.projectId, threadId: f.threadId }) })));
    save(); console.log(JSON.stringify({ phase: 'preparation-requested', accepted: evidence.preparations.filter(x => x.started).length, total: count }));
    assert(evidence.preparations.every(x => x.started), 'Expected preparations were not admitted');
    const shell = await clients.values().next().value.rpc('orchestration.getShellSnapshot', {});
    assert(!shell.threads.some(t => fixtures.some(f => f.threadId === t.id)), 'Preparing a draft must not publish empty chats');
    await new Promise(resolve => setTimeout(resolve, Math.max(0, prepareMs - (Date.now() - started))));
    collectOwnedWorkers(); evidence.preparationWindowMs = Date.now() - started;
    evidence.preparedWorkerIds = Object.fromEntries([...ownedByThread].map(([thread, ids]) => [thread, [...ids]])); save();
    assert(fixtures.every(f => evidence.preparedWorkerIds[f.threadId]?.length === 1), 'Every admitted preparation must own one worker before the message');
  }
  for (const [i, f] of fixtures.entries()) {
    await command({ type: 'thread.create', threadId: f.threadId, projectId: f.projectId, title: 'QA Daytona ' + i,
      modelSelection: { provider: 'pi', model: f.model, options: { thinkingLevel: 'low' } },
      runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null });
    createdThreads.add(f.threadId);
  }
  const turn = async (f, kind, text) => {
    const messageId = randomUUID(); const start = Date.now();
    await command({ type: 'thread.turn.start', threadId: f.threadId, message: { messageId, role: 'user', text, attachments: [] }, runtimeMode: 'full-access', interactionMode: 'default' });
    let snapshot;
    let firstTextObservedMs = null;
    while (Date.now() - start < 300000) {
      snapshot = await rpc('orchestration.getThreadDetailSnapshot', { threadId: f.threadId });
      const messages = snapshot?.thread?.messages ?? [];
      const userIndex = messages.findIndex(m => m.id === messageId);
      if (firstTextObservedMs === null && userIndex >= 0 && messages.slice(userIndex + 1).some(m => m.role === 'assistant' && m.text)) firstTextObservedMs = Date.now() - start;
      const t = snapshot?.thread?.latestTurn;
      if (userIndex >= 0 && snapshot?.thread?.activities?.some(a => a.kind === 'provider.turn.start.failed' && Date.parse(a.createdAt) >= start - 2000)) break;
      if (snapshot?.thread?.messages?.some(m => m.id === messageId) && t?.completedAt && Date.parse(t.requestedAt) >= start - 2000) break;
      await new Promise(r => setTimeout(r, 600));
    }
    const t = snapshot?.thread?.latestTurn;
    const answer = snapshot?.thread?.messages?.filter(m => m.role === 'assistant').at(-1)?.text ?? '';
    writeFileSync(path.join(root, f.threadId + '-' + kind + '.snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
    const trial = { kind, threadId: f.threadId, company: f.company, model: f.model, state: t?.state, requestedAt: t?.requestedAt, startedAt: t?.startedAt, completedAt: t?.completedAt, readinessMs: t?.startedAt ? Date.parse(t.startedAt) - Date.parse(t.requestedAt) : null, firstTextObservedMs, firstTextPollIntervalMs: 600, totalMs: Date.now() - start, markerMatched: answer.includes(f.marker), activityKinds: snapshot?.thread?.activities?.slice(-12).map(a => a.kind), runtimeErrors: snapshot?.thread?.activities?.filter(a => a.kind === 'runtime.error').map(a => ({ class: a.payload?.class, message: a.payload?.message })) };
    trial.startFailures = snapshot?.thread?.activities?.filter(a => a.kind === 'provider.turn.start.failed' && Date.parse(a.createdAt) >= start - 2000).map(a => ({ detail: a.payload?.detail }));
    evidence.trials.push(trial); save(); console.log(JSON.stringify({ phase: 'turn', kind, threadId: f.threadId, company: f.company, model: f.model, state: trial.state, readinessMs: trial.readinessMs, totalMs: trial.totalMs }));
    if (kind === 'profile-mcp') {
      trial.crunchbaseSearchCompleted = snapshot?.thread?.activities?.some(a => a.kind === 'tool.completed' && a.payload?.title === 'crunchbase_search' && Date.parse(a.createdAt) >= start - 2000);
      save();
      assert(trial.crunchbaseSearchCompleted, 'Configured profile must execute the real Crunchbase search tool');
    }
    assert(t?.completedAt && t.state === 'completed', 'Turn failed: ' + trial.state + ' ' + JSON.stringify({ runtimeErrors: trial.runtimeErrors, startFailures: trial.startFailures }));
    assert(answer.includes(f.marker), 'Private thread marker missing from response');
    return trial;
  };
  const cold = [];
  for (let start = 0; start < fixtures.length; start += coldBurst) {
    const batch = await Promise.allSettled(fixtures.slice(start, start + coldBurst).map(f => turn(f, 'new', `Dev file readiness check for ${f.company}. Find one real file under inbox (prefer an image or PDF), read its bytes and report basename, size and SHA256. Write the exact private token ${f.marker} to ${f.note}. Python3 and Node are available; correct any tool error before finishing. Do not publish, push Git, run diligence, research, email or edit existing files. Reply with your token and file check results, briefly.`)));
    cold.push(...batch);
    if (batch.some(r => r.status === 'rejected')) break;
  }
  evidence.coldSkippedCount = fixtures.length - cold.length;
  evidence.coldFailures = cold.flatMap((r, i) => r.status === 'rejected' ? [{ threadId: fixtures[i].threadId, error: r.reason.message }] : []); save();
  assert.equal(evidence.coldFailures.length, 0, JSON.stringify(evidence.coldFailures));
  collectOwnedWorkers();
  if (process.argv.includes('--profile-check') || process.argv.includes('--profile-check-all')) for (const f of process.argv.includes('--profile-check-all') ? fixtures : [fixtures[0]])
    await turn(f, 'profile-mcp', `Use crunchbase_search once to check the company identity for ${f.company}, with limit 1 if supported. Say whether the result contains a matching company; do not invent a match. Then read your private file ${f.note} and include its exact token ${f.marker}. Keep the answer brief; do not publish or edit any file.`);
  for (const f of fixtures) {
    const ids = [...(ownedByThread.get(f.threadId) ?? [])];
    assert.equal(ids.length, 1, 'A cold QA thread must have one directly mapped native worker');
    if (prepareMs > 0) assert.equal(ids[0], evidence.preparedWorkerIds[f.threadId][0], 'The first send must use its prepared worker');
    const sandbox = await d.get(ids[0]);
    const other = companies.find(company => company !== f.company);
    const check = `const fs=require('node:fs');process.setgroups([]);process.setgid(10001);process.setuid(10001);const denied=p=>{try{fs.accessSync(p,fs.constants.R_OK);return false}catch{return true}};const checks={uid:process.getuid()===10001,rootDenied:denied('/root'),sudoDenied:require('node:child_process').spawnSync('sudo',['-n','true'],{stdio:'ignore'}).status!==0,controllerCredentialDenied:denied('/opt/synara/provider-worker.json'),repositoryCredentialDenied:denied('/root/.synara-repository-credential.gitconfig'),storageCredentialDenied:denied('/root/.synara-s3-lfs.passwd'),otherCompanyAbsent:!fs.existsSync(${JSON.stringify('/workspace/repository/companies/' + other)}),privateMarker:fs.readFileSync(${JSON.stringify('/workspace/repository/companies/' + f.company + '/' + f.note)},'utf8').trim()===${JSON.stringify(f.marker)}};console.log(JSON.stringify(checks));if(Object.values(checks).some(x=>!x))process.exit(1)`;
    const result = await sandbox.process.executeCommand('sudo -n -E sh -lc ' + quote('node -e ' + quote(check)), undefined, undefined, 15);
    evidence.trials.push({ kind: 'native-isolation-command', threadId: f.threadId, sandboxId: ids[0], exitCode: result.exitCode, output: result.result }); save();
    assert.equal(result.exitCode, 0, 'Native UID/credential/company isolation command failed');
    const checks = JSON.parse(result.result);
    evidence.trials.push({ kind: 'native-isolation', threadId: f.threadId, sandboxId: ids[0], checks }); save();
    assert.equal(result.exitCode, 0, 'Native UID/credential/company isolation failed');
  }
  for (let repeat = 0; repeat < 3; repeat++) {
    const results = await Promise.allSettled(fixtures.map(f => turn(f, 'warm-' + repeat, `Read only your private file ${f.note}; reply with its exact token ${f.marker}, the company name and nothing else. Do not call any other tool.`)));
    const failures = results.flatMap((r, i) => r.status === 'rejected' ? [{ threadId: fixtures[i].threadId, error: r.reason.message }] : []);
    assert.equal(failures.length, 0, JSON.stringify(failures));
  }
  for (const f of fixtures) {
    const response = await fetch(origin + '/api/chat-persistence/workspace-file?' + new URLSearchParams({ threadId: f.threadId, path: '/workspace/repository/companies/' + f.company + '/' + f.note }), { headers: { Authorization: 'Bearer ' + session.sessionToken }, signal: AbortSignal.timeout(30000) });
    const body = await response.text();
    evidence.trials.push({ kind: 'private-preview', threadId: f.threadId, status: response.status, markerMatched: body.trim() === f.marker }); save();
    assert(response.ok && body.trim() === f.marker, 'Private file differs; HTTP ' + response.status);
  }
  if (fixtures.length > 1) {
    const limited = await http('/api/auth/external/session', vars.SYNARA_EXTERNAL_AUTH_SECRET, { subject: 'daytona-readiness-limited-' + runId, email: 'daytona-readiness@glasswing.invalid', allowedProjectIds: [fixtures[0].projectId], expiresAt: new Date(Date.now() + 840000).toISOString(), nonce: randomUUID() });
    const other = fixtures.find(f => f.projectId !== fixtures[0].projectId);
    if (other) {
      const denied = await fetch(origin + '/api/chat-persistence/workspace-file?' + new URLSearchParams({ threadId: other.threadId, path: '/workspace/repository/companies/' + other.company + '/' + other.note }), { headers: { Authorization: 'Bearer ' + limited.sessionToken }, signal: AbortSignal.timeout(30000) });
      evidence.trials.push({ kind: 'cross-project-preview-denied', status: denied.status }); save();
      assert.equal(denied.status, 403, 'A scoped company session must not read another QA company');
    }
  }
  // Deliberate lifecycle faults apply only to the uniquely named QA threads.
  const first = fixtures[0];
  const worker = await d.get([...ownedByThread.get(first.threadId)][0]);
  const writerPath = '/workspace/repository/companies/' + first.company + '/' + first.note + '.writer';
  const writer = `const fs=require('node:fs'),p=${JSON.stringify(writerPath)};let tick=0;setInterval(()=>{fs.writeFileSync(p+'.pending',JSON.stringify({marker:${JSON.stringify(first.marker)},tick:++tick}));fs.renameSync(p+'.pending',p)},100)`;
  const launch = `const{spawn}=require('node:child_process');process.setgroups([]);process.setgid(10001);process.setuid(10001);spawn('node',['-e',${JSON.stringify(writer)}],{detached:true,stdio:'ignore'}).unref()`;
  const started = await worker.process.executeCommand('sudo -n -E sh -lc ' + quote('node -e ' + quote(launch)), undefined, undefined, 15);
  assert.equal(started.exitCode, 0, 'Owned detached writer launch failed');
  await new Promise(r => setTimeout(r, 400));
  const beforeStop = await worker.process.executeCommand('sudo -n -E sh -lc ' + quote('node -e ' + quote(`console.log(require('node:fs').readFileSync(${JSON.stringify(writerPath)},'utf8'))`)), undefined, undefined, 15);
  assert.equal(beforeStop.exitCode, 0, 'Owned writer state could not be observed before stop');
  const beforeTick = JSON.parse(beforeStop.result).tick;
  await command({ type: 'thread.session.stop', threadId: fixtures[0].threadId });
  if (prepareMs > 0) {
    const preparation = await rpc('provider.prepareWorkspace', { projectId: first.projectId, threadId: first.threadId });
    evidence.preparations.push({ threadId: first.threadId, kind: 'stopped-resume', ...preparation }); save();
    assert(preparation.started, 'Stopped conversation preparation was not admitted');
    await new Promise(resolve => setTimeout(resolve, prepareMs));
  }
  await turn(fixtures[0], 'stopped-resume', `Read your private file ${fixtures[0].note} and its companion ${fixtures[0].note}.writer; reply with exact token ${fixtures[0].marker} and the writer tick, briefly.`);
  const restored = await fetch(origin + '/api/chat-persistence/workspace-file?' + new URLSearchParams({ threadId: first.threadId, path: writerPath }), { headers: { Authorization: 'Bearer ' + session.sessionToken }, signal: AbortSignal.timeout(30000) });
  assert(restored.ok, 'Stopped writer bytes were not restored');
  const bytes = await restored.json();
  assert(bytes.marker === first.marker && bytes.tick >= beforeTick && beforeTick > 0, 'Latest observed detached writer state missing');
  await new Promise(r => setTimeout(r, 500));
  const stable = await fetch(origin + '/api/chat-persistence/workspace-file?' + new URLSearchParams({ threadId: first.threadId, path: writerPath }), { headers: { Authorization: 'Bearer ' + session.sessionToken }, signal: AbortSignal.timeout(30000) }).then(r => r.json());
  assert.deepEqual(stable, bytes, 'Detached writer survived retirement');
  evidence.trials.push({ kind: 'detached-writer-stop-restore', threadId: first.threadId, beforeTick, restoredTick: bytes.tick, stable: true });
  collectOwnedWorkers();
  evidence.passed = true; save();
  }
} catch (error) { evidence.error = error.message; save(); throw error; }
finally {
  if (fixtures.length) {
    try { collectOwnedWorkers(); }
    catch (error) { evidence.cleanup.push({ ownershipReadFailed: true, error: error.message }); save(); }
  }
  // A failed draft check has no orchestration thread to authorize normal deletion.
  // Materialize only this run's disposable QA fixture so the ordinary fenced
  // retirement path can reclaim it immediately rather than waiting for expiry.
  if (prepareMs > 0 && command) for (const f of fixtures.filter(f => !createdThreads.has(f.threadId))) {
    try {
      await command({ type: 'thread.create', threadId: f.threadId, projectId: f.projectId,
        title: 'QA preparation cleanup', modelSelection: { provider: 'pi', model: f.model ?? model },
        runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null });
      evidence.cleanup.push({ threadId: f.threadId, cleanupThreadCreated: true }); save();
    } catch (error) { evidence.cleanup.push({ threadId: f.threadId, cleanupThreadCreated: false, error: error.message }); save(); }
  }
  // Let the controller retire only the uniquely owned QA threads. Do not infer
  // ownership from a before/after inventory when users can create chats concurrently.
  for (const [type, items, key] of [['thread.delete', fixtures, 'threadId'], ['project.delete', projects, 'projectId']]) {
    for (const item of items) {
      const id = type === 'project.delete' ? item.id : item.threadId;
      try {
        assert(command, 'Reconnect with the scoped QA session to finish cleanup');
        await command({ type, [key]: id });
        evidence.cleanup.push({ [key]: id, deletionRequested: true });
      } catch (error) { evidence.cleanup.push({ [key]: id, deletionRequested: false, error: error.message }); }
      save();
    }
  }
  for (const client of clients.values()) client.ws.close();
  for (const id of new Set([...ownedByThread.values()].flatMap(ids => [...ids]))) {
    let state = 'unknown';
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try { state = (await d.get(id)).state; }
      catch (error) { if (error.statusCode === 404 || error.status === 404 || error.response?.status === 404) { state = 'destroyed'; break; } throw error; }
      await new Promise(r => setTimeout(r, 1000));
    }
    evidence.cleanup.push({ sandboxId: id, physicalState: state }); save();
  }
  if (ownedPool && pool) {
    try { await d.warmPool.delete(pool.id); evidence.cleanup.push({ warmPoolId: pool.id, deleted: true }); }
    catch (error) { evidence.cleanup.push({ warmPoolId: pool.id, deleted: false, error: error.message }); }
    save();
  }
  const after = [];
  for await (const sandbox of d.list({ labels: { 'synara-managed': 'true' } })) if (!before.has(sandbox.id)) after.push({ id: sandbox.id, state: sandbox.state });
  evidence.newManagedDisksAtExit = after; // Includes concurrent users; never delete them from this inventory.
  evidence.passed = evidence.passed === true && !evidence.cleanup.some(c => c.ownershipReadFailed || c.deletionRequested === false || c.deleted === false || c.physicalState && c.physicalState !== 'destroyed');
  save();
  console.log(JSON.stringify({ phase: 'done', passed: evidence.passed ?? false, evidence: path.join(root, 'evidence.json') }));
}
