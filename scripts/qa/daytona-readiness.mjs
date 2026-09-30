/** Real dev-only chats and native warm-pool claims. No production or canonical Git writes. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { availableDaytonaContainerTargets } from '../../apps/server/src/workspaceRuntime/daytonaRegions.ts';
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { Daytona } = await import(require.resolve('@daytona/sdk'));
const { default: WebSocket } = await import(require.resolve('ws'));
assert(process.argv.includes('--run-dev'), 'Pass --run-dev for real, disposable dev trials');
const count = Number(process.argv.find(x => x.startsWith('--count='))?.split('=')[1] ?? 4);
assert(Number.isInteger(count) && count > 0 && count <= 98);
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
const evidence = { checkedAt: new Date().toISOString(), runId, count, config: { preferredTarget: vars.SYNARA_DAYTONA_TARGET, target, snapshot, maxActive: vars.SYNARA_DAYTONA_MAX_ACTIVE_SANDBOXES }, trials: [], cleanup: [] };
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
let command;
let ws;
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
  const ticket = await http('/api/auth/ws-token', session.sessionToken);
  const negotiated = await fetch(origin + '/ws/negotiate?x-synara-client-build=0.7.3&x-synara-protocol-epoch=1&x-synara-protocol-min-revision=1&x-synara-protocol-max-revision=1').then(r => r.json());
  ws = new WebSocket(origin.replace('https:', 'wss:') + '/ws?' + new URLSearchParams({ wsToken: ticket.token, 'x-synara-client-build': '0.7.3', 'x-synara-protocol-epoch': '1', 'x-synara-protocol-revision': '1', 'x-synara-server-instance': negotiated.serverInstanceId }), { headers: { Origin: 'https://glasswing-web-dev-0e4d.up.railway.app' } });
  let sequence = 0;
  const pending = new Map();
  ws.on('message', raw => { for (const x of [JSON.parse(String(raw))].flat()) {
    if (x._tag === 'Ping') ws.send(JSON.stringify({ _tag: 'Pong' }));
    if (x._tag === 'Chunk') ws.send(JSON.stringify({ _tag: 'Ack', requestId: x.requestId }));
    if (x._tag === 'Exit') { const p = pending.get(String(x.requestId)); if (p) { pending.delete(String(x.requestId)); clearTimeout(p.timer); x.exit._tag === 'Success' ? p.resolve(x.exit.value) : p.reject(Error(JSON.stringify(x.exit).slice(0, 1500))); } }
  } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const rpc = (tag, payload) => new Promise((resolve, reject) => { const id = String(++sequence); const timer = setTimeout(() => { pending.delete(id); reject(Error('RPC deadline: ' + tag)); }, 30000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] })); });
  command = data => rpc('orchestration.dispatchCommand', { commandId: randomUUID(), createdAt: new Date().toISOString(), ...data });
  if (!cleanupSource) {
  for (let i = 0; i < count; i++) {
    const project = projects[count >= 25 && i < 10 ? 0 : i % projects.length];
    const f = { threadId: randomUUID(), projectId: project.id, company: project.company, marker: randomUUID(), note: 'analysis/daytona-qa-' + runId + '-' + i + '.txt' };
    fixtures.push(f); evidence.fixtures = fixtures; save();
    await command({ type: 'thread.create', threadId: f.threadId, projectId: f.projectId, title: 'QA Daytona ' + i, modelSelection: { provider: 'pi', model: 'anthropic/claude-opus-5', options: { thinkingLevel: 'minimal' } }, runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null });
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
      if (snapshot?.thread?.messages?.some(m => m.id === messageId) && t?.completedAt && Date.parse(t.requestedAt) >= start - 2000) break;
      await new Promise(r => setTimeout(r, 600));
    }
    const t = snapshot?.thread?.latestTurn;
    const answer = snapshot?.thread?.messages?.filter(m => m.role === 'assistant').at(-1)?.text ?? '';
    const trial = { kind, threadId: f.threadId, company: f.company, state: t?.state, requestedAt: t?.requestedAt, startedAt: t?.startedAt, completedAt: t?.completedAt, readinessMs: t?.startedAt ? Date.parse(t.startedAt) - Date.parse(t.requestedAt) : null, firstTextObservedMs, firstTextPollIntervalMs: 600, totalMs: Date.now() - start, markerMatched: answer.includes(f.marker), activityKinds: snapshot?.thread?.activities?.slice(-12).map(a => a.kind), runtimeErrors: snapshot?.thread?.activities?.filter(a => a.kind === 'runtime.error').map(a => ({ class: a.payload?.class, message: a.payload?.message })) };
    evidence.trials.push(trial); save(); console.log(JSON.stringify({ phase: 'turn', kind, threadId: f.threadId, company: f.company, state: trial.state, readinessMs: trial.readinessMs, totalMs: trial.totalMs }));
    assert(t?.completedAt && t.state === 'completed', 'Turn failed: ' + trial.state + ' ' + JSON.stringify(trial.runtimeErrors));
    assert(answer.includes(f.marker), 'Private thread marker missing from response');
    return trial;
  };
  const cold = await Promise.allSettled(fixtures.map(f => turn(f, 'new', `Dev file readiness check for ${f.company}. In ONE execution tool call, find one real file under inbox (prefer an image or PDF), read its bytes and report basename, size and SHA256. Write the exact private token ${f.marker} to ${f.note}. Do not publish, push Git, run diligence, research, email or edit existing files. Reply with your token and file check results, briefly.`)));
  evidence.coldFailures = cold.flatMap((r, i) => r.status === 'rejected' ? [{ threadId: fixtures[i].threadId, error: r.reason.message }] : []); save();
  assert.equal(evidence.coldFailures.length, 0, JSON.stringify(evidence.coldFailures));
  for (let repeat = 0; repeat < 3; repeat++) await Promise.all(fixtures.map(f => turn(f, 'warm-' + repeat, `Read only your private file ${f.note}; reply with its exact token ${f.marker}, the company name and nothing else. Do not call any other tool.`)));
  for (const f of fixtures) {
    const response = await fetch(origin + '/api/chat-persistence/workspace-file?' + new URLSearchParams({ threadId: f.threadId, path: '/workspace/repository/companies/' + f.company + '/' + f.note }), { headers: { Authorization: 'Bearer ' + session.sessionToken }, signal: AbortSignal.timeout(30000) });
    const body = await response.text();
    evidence.trials.push({ kind: 'private-preview', threadId: f.threadId, status: response.status, markerMatched: body.trim() === f.marker }); save();
    assert(response.ok && body.trim() === f.marker, 'Private file differs; HTTP ' + response.status);
  }
  // Deliberate lifecycle faults apply only to the uniquely named QA threads.
  await command({ type: 'thread.session.stop', threadId: fixtures[0].threadId });
  await turn(fixtures[0], 'stopped-resume', `Read your private file ${fixtures[0].note}; reply with exact token ${fixtures[0].marker} and nothing else.`);
  evidence.passed = true; save();
  }
} catch (error) { evidence.error = error.message; save(); throw error; }
finally {
  // Let the controller retire only the uniquely owned QA threads. Do not infer
  // ownership from a before/after inventory when users can create chats concurrently.
  for (const [type, items, key] of [['thread.delete', fixtures, 'threadId'], ['project.delete', projects, 'projectId']]) {
    for (const item of items) {
      const id = type === 'project.delete' ? item.id : item.threadId;
      try {
        assert(command && ws?.readyState === WebSocket.OPEN, 'Reconnect with the scoped QA session to finish cleanup');
        await command({ type, [key]: id });
        evidence.cleanup.push({ [key]: id, deletionRequested: true });
      } catch (error) { evidence.cleanup.push({ [key]: id, deletionRequested: false, error: error.message }); }
      save();
    }
  }
  ws?.close();
  if (ownedPool && pool) {
    try { await d.warmPool.delete(pool.id); evidence.cleanup.push({ warmPoolId: pool.id, deleted: true }); }
    catch (error) { evidence.cleanup.push({ warmPoolId: pool.id, deleted: false, error: error.message }); }
    save();
  }
  const after = [];
  for await (const sandbox of d.list({ labels: { 'synara-managed': 'true' } })) if (!before.has(sandbox.id)) after.push({ id: sandbox.id, state: sandbox.state });
  evidence.newManagedDisksAtExit = after; // Includes concurrent users; never delete them from this inventory.
  save();
  console.log(JSON.stringify({ phase: 'done', passed: evidence.passed ?? false, evidence: path.join(root, 'evidence.json') }));
}
