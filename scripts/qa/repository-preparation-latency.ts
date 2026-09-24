/** Generate a real-sandbox trial; creates only a disposable checkout, never infrastructure.
 * Run with Node 24 or Bun: <this file> <configuration.json> > trial.sh
 * Configuration: binding, repositoryOrigin, credentialConfigPath, mountRoot, probePath.
 * Upload trial.sh to an already prepared Linux sandbox and run with sh. It retains
 * the checkout for inspection; the caller owns sandbox cleanup and credentials.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  makeRepositoryCheckoutPlan,
  makeRepositoryRefreshPlan,
  hydrateLfs,
  uncoverLfs,
} from "../../apps/server/src/providerWorker/repositoryCheckout.ts";

const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Parameters<typeof makeRepositoryCheckoutPlan>[0] & {
  probePath: string;
};
if (!input.mountRoot || !input.probePath || input.probePath.split("/").some(part => !part || part === "..")) {
  throw Error("A prepared S3 mount and company-relative material probe are required.");
}
const checkoutRoot = `/workspace/repository-preparation-qa-${randomUUID()}`;
const options = { ...input, checkoutRoot, companyOnly: true };
const checkout = makeRepositoryCheckoutPlan(options);
const refresh = makeRepositoryRefreshPlan(options);
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const node = (script: string) => `node -e ${quote(script)}`;
const scope = input.binding.path;
const readMounts = `
const fs = require('node:fs');
const prefix = ${JSON.stringify(checkoutRoot + "/" + scope + "/")};
const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\\n').filter(line => {
  const target = (line.split(' ')[4] || '').replace(/\\\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
  return target.startsWith(prefix);
});
`;
const mountSnapshot = node(readMounts + `if (!mounts.length) throw Error('No company material bindings'); process.stdout.write(mounts.sort().join('\\n') + '\\n');`);
const verifyUnmounted = node(readMounts + `if (mounts.length) throw Error('Company material bindings remain after uncover');`);
const verifyMaterial = node(`
const assert = require('node:assert/strict'), fs = require('node:fs'), cp = require('node:child_process'), crypto = require('node:crypto');
const root = ${JSON.stringify(checkoutRoot)}, scope = ${JSON.stringify(scope)}, probe = scope + '/' + ${JSON.stringify(input.probePath)};
const git = args => cp.execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'}).trim();
assert.equal(git(['ls-tree', '--name-only', 'HEAD:companies']), scope.split('/').at(-1), 'Sibling company is reachable');
const pointer = git(['show', 'HEAD:' + probe]);
const oid = pointer.match(/^oid sha256:([a-f0-9]{64})$/m)?.[1];
assert.ok(oid, 'Probe must be a real canonical LFS material');
const bytes = fs.readFileSync(root + '/' + probe);
assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), oid);
cp.execFileSync('setpriv', ['--reuid=10001', '--regid=10001', '--clear-groups', 'node', '-e',
  'const fs=require("node:fs"),assert=require("node:assert/strict");fs.readFileSync(process.argv[1]);assert.throws(()=>fs.openSync(process.argv[1],"r+"));assert.throws(()=>fs.readdirSync(process.argv[2]));',
  root + '/' + probe, ${JSON.stringify(input.mountRoot)}]);
console.log('__QA_MATERIAL__=' + JSON.stringify({path: ${JSON.stringify(input.probePath)}, bytes: bytes.length, sha256: oid, isolated: true, readOnly: true}));
`);
const draftPath = `${checkoutRoot}/${scope}/qa-untracked-draft.md`;
const verifyDraft = node(`require('node:assert/strict').equal(require('node:fs').readFileSync(${JSON.stringify(draftPath)},'utf8'),'Unpublished analyst draft\\n')`);
const preview = hydrateLfs(checkoutRoot, scope, `${input.repositoryOrigin ?? input.binding.origin}/${input.binding.owner}/${input.binding.repository}.git`, input.binding.origin, input.credentialConfigPath, input.mountRoot, `${scope}/${input.probePath}`);
const prepareEditedBinary = node(`
const fs = require('node:fs'), cp = require('node:child_process');
const root = ${JSON.stringify(checkoutRoot)}, probe = ${JSON.stringify(scope + "/" + input.probePath)};
const git = args => cp.execFileSync('git', ['-C', root, ...args], {encoding:'utf8'});
const paths = git(['ls-tree','-r','--name-only','-z','HEAD','--',${JSON.stringify(scope)}]).split('\\0').filter(Boolean);
const other = paths.find(name => name !== probe && git(['show','HEAD:'+name]).startsWith('version https://git-lfs.github.com/spec/v1\\n'));
if (!other) throw Error('A second real LFS material is required for the draft-preservation trial');
fs.writeFileSync(root+'/.git/qa-edited-path',other);
fs.writeFileSync(root+'/.git/qa-attributes-before',fs.readFileSync(root+'/.git/info/attributes'));
fs.writeFileSync(root+'/'+other,'Unpublished edited binary draft\\n');
`);
const verifyEditedBinary = node(`
const fs = require('node:fs'), assert = require('node:assert/strict'), root = ${JSON.stringify(checkoutRoot)};
assert.equal(fs.readFileSync(root+'/'+fs.readFileSync(root+'/.git/qa-edited-path','utf8'),'utf8'),'Unpublished edited binary draft\\n');
assert.deepEqual(fs.readFileSync(root+'/.git/info/attributes'),fs.readFileSync(root+'/.git/qa-attributes-before'));
`);
const restorePointer = node(`
const fs=require('node:fs'),cp=require('node:child_process'),root=${JSON.stringify(checkoutRoot)};
const name=fs.readFileSync(root+'/.git/qa-edited-path','utf8');
fs.writeFileSync(root+'/'+name,cp.execFileSync('git',['-C',root,'show','HEAD:'+name]));
`);

process.stdout.write([
  "set -eu",
  `test ! -e ${quote(checkoutRoot)}`,
  `mark() { printf '__QA_PHASE__ %s %s\\n' "$1" "$(node -e 'process.stdout.write(String(Date.now()))')"; }`,
  "mark checkout.begin",
  `( ${checkout.command} )`,
  "mark checkout.end",
  verifyMaterial,
  `${mountSnapshot} > ${quote(checkoutRoot + "/.git/qa-mounts-before")}`,
  `printf 'Unpublished analyst draft\\n' > ${quote(draftPath)}`,
  "mark warm.begin",
  `( ${refresh.command} )`,
  "mark warm.end",
  `${mountSnapshot} > ${quote(checkoutRoot + "/.git/qa-mounts-after")}`,
  `cmp ${quote(checkoutRoot + "/.git/qa-mounts-before")} ${quote(checkoutRoot + "/.git/qa-mounts-after")}`,
  verifyDraft,
  uncoverLfs(checkoutRoot, scope, input.mountRoot),
  verifyUnmounted,
  "mark rebind.begin",
  `( ${refresh.command} )`,
  "mark rebind.end",
  `${mountSnapshot} > ${quote(checkoutRoot + "/.git/qa-mounts-rebound")}`,
  verifyDraft,
  verifyMaterial,
  uncoverLfs(checkoutRoot, scope, input.mountRoot),
  verifyUnmounted,
  prepareEditedBinary,
  "mark targeted-preview.begin",
  preview,
  "mark targeted-preview.end",
  verifyEditedBinary,
  verifyMaterial,
  `if ( ${refresh.command} ) > ${quote(checkoutRoot + "/.git/qa-expected-conflict.log")} 2>&1; then echo 'Full hydration overwrote or ignored an edited binary' >&2; exit 1; fi`,
  verifyEditedBinary,
  restorePointer,
  `( ${refresh.command} )`,
  verifyDraft,
  verifyMaterial,
  "printf '__QA_EDITED_BINARY__=preserved; targeted preview passed; full hydration refused; recovery passed\\n'",
  `printf '__QA_PASS__=%s\\n' ${quote(checkoutRoot)}`,
].join("\n") + "\n");
