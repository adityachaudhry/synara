/** Real existing-company HTTP/WS check; emits timings and counts, never credentials or chats. */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const WebSocket = require('ws');
const environment = process.argv.includes('--production') ? 'production' : 'dev';
const service = environment === 'dev' ? 'synara-gitea-dev' : 'synara-gitea-production';
const variables = JSON.parse(execFileSync('railway', ['variables', '--project', '2fb578c6-304e-4a97-abd4-38b3897d9030', '--environment', environment, '--service', service, '--json'], { encoding: 'utf8' }));
const origin = environment === 'dev' ? 'https://synara-gitea-dev-dev-6df3.up.railway.app' : 'https://synara-gitea-production-production-cfb2.up.railway.app';
async function request(path, token, body) {
  const started = performance.now();
  const response = await fetch(origin + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  console.log(JSON.stringify({ environment, path, status: response.status, ms: Math.round(performance.now() - started) }));
  if (!response.ok) throw Error('HTTP ' + response.status);
  return response.json();
}
const project = await request('/api/external/projects/resolve', variables.SYNARA_EXTERNAL_AUTH_SECRET, {
  externalKey: 'glasswing-company:2f91a377-3951-4515-8bdf-2b03dbf1261a', name: 'Harbor',
  repositoryBinding: { kind: 'git-subdirectory', origin: variables.SYNARA_GITEA_ORIGIN, owner: variables.SYNARA_GITEA_OWNER, repository: variables.SYNARA_GITEA_REPOSITORY, ref: 'main', path: 'companies/harbor' },
});
const session = await request('/api/auth/external/session', variables.SYNARA_EXTERNAL_AUTH_SECRET, { subject: 'workspace-loading-qa', email: 'workspace-loading@glasswing.invalid', allowedProjectIds: [project.projectId], expiresAt: new Date(Date.now() + 90000).toISOString(), nonce: crypto.randomUUID() });
const ticket = await request('/api/auth/ws-token', session.sessionToken);
const negotiation = await (await fetch(origin + '/ws/negotiate?x-synara-client-build=0.7.3&x-synara-protocol-epoch=1&x-synara-protocol-min-revision=1&x-synara-protocol-max-revision=1', { signal: AbortSignal.timeout(15000) })).json();
const socket = new WebSocket(origin.replace('https:', 'wss:') + '/ws?' + new URLSearchParams({ wsToken: ticket.token, 'x-synara-client-build': '0.7.3', 'x-synara-protocol-epoch': '1', 'x-synara-protocol-revision': '1', 'x-synara-server-instance': negotiation.serverInstanceId }), { headers: { Origin: environment === 'dev' ? 'https://glasswing-web-dev-0e4d.up.railway.app' : 'https://app.glasswing.vc' } });
let pending;
socket.on('message', raw => {
  for (const message of [JSON.parse(String(raw))].flat()) {
    if (message._tag === 'Ping') socket.send(JSON.stringify({ _tag: 'Pong' }));
    if (message._tag === 'Chunk') socket.send(JSON.stringify({ _tag: 'Ack', requestId: message.requestId }));
    if (pending && message._tag === 'Exit' && String(message.requestId) === pending.id) {
      clearTimeout(pending.timer);
      message.exit._tag === 'Success' ? pending.resolve(message.exit.value) : pending.reject(Error('RPC rejected'));
      pending = undefined;
    }
  }
});
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
try {
  for (const [index, tag] of ['server.refreshProviders', 'orchestration.getShellSnapshot', 'provider.listModels'].entries()) {
    const started = performance.now();
    const result = await new Promise((resolve, reject) => {
      const id = String(index + 1);
      const timer = setTimeout(() => { pending = undefined; reject(Error(tag + ' deadline')); }, 15000);
      pending = { id, resolve, reject, timer };
      socket.send(JSON.stringify({ _tag: 'Request', id, tag, payload: tag === 'provider.listModels' ? { provider: 'pi' } : {}, headers: [] }));
    });
    if (tag === 'orchestration.getShellSnapshot' && !result.projects.some(p => p.id === project.projectId)) throw Error('Authorized company is absent from the shell');
    if (tag === 'provider.listModels' && !result.models.length) throw Error('Model catalog is empty');
    console.log(JSON.stringify({ environment, tag, ms: Math.round(performance.now() - started), providers: result.providers?.length, projects: result.projects?.length, models: result.models?.length }));
  }
} finally { socket.close(); }
