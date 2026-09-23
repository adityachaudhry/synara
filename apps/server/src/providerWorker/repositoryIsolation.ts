import { randomUUID } from "node:crypto";
import { hydrateLfs, makeRepositoryCheckoutPlan, makeRepositoryRefreshPlan, REPOSITORY_CHECKOUT_ROOT, uncoverLfs } from "./repositoryCheckout";

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Convert an existing checkout without losing draft files or importing global Git ancestry. */
export function makeRepositoryIsolationPlan(input: Parameters<typeof makeRepositoryCheckoutPlan>[0] & { readonly allowEmpty?: boolean; readonly verifiedCommit?: string | undefined }) {
  const root = input.checkoutRoot ?? REPOSITORY_CHECKOUT_ROOT;
  const staging = `${root}.company-${randomUUID()}`;
  const { mountRoot: _mountRoot, ...checkoutInput } = input;
  const checkout = makeRepositoryCheckoutPlan({ ...checkoutInput, checkoutRoot: staging, companyOnly: true });
  const script = `
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const root = ${JSON.stringify(root)}, staging = ${JSON.stringify(staging)}, scope = ${JSON.stringify(input.binding.path)};
const git = (dir, args, data) => cp.execFileSync('git', ['-C', dir, ...args], {input:data, maxBuffer:128*1024*1024});
const previous = ${JSON.stringify(input.allowEmpty ? undefined : input.verifiedCommit)};
if (!previous && !${JSON.stringify(input.allowEmpty === true)}) {
 fs.rmSync(staging,{recursive:true,force:true}); throw Error('A verified source baseline is required; original workspace retained');
}

try {
 const patch = previous ? git(root, ['diff','--binary','--full-index',previous,'--',scope]) : Buffer.alloc(0);
 // Three-way application needs only the changed base blobs, never sibling trees.
 for (const match of patch.toString().matchAll(/^index ([a-f0-9]{40})\\.\\./gm)) {
  if (/^0+$/.test(match[1])) continue;
  const bytes = git(root, ['cat-file','blob',match[1]]);
  if (git(staging, ['hash-object','-w','--stdin'],bytes).toString().trim() !== match[1]) throw Error('Draft base verification failed');
 }
 // Unpublished LFS bytes live only in the original checkout. Hand off exactly those objects.
 for (const match of patch.toString().matchAll(/^\\+oid sha256:([a-f0-9]{64})$/gm)) {
  const oid=match[1], suffix=path.join('.git','lfs','objects',oid.slice(0,2),oid.slice(2,4),oid);
  const source=path.join(root,suffix), target=path.join(staging,suffix);
  if (!fs.lstatSync(source).isFile()) throw Error('Unpublished LFS object unavailable; original workspace retained');
  const bytes=fs.readFileSync(source);
  if (require('node:crypto').createHash('sha256').update(bytes).digest('hex') !== oid) throw Error('Unpublished LFS integrity check failed');
  fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,bytes,{mode:0o600});
 }
 if (patch.length) git(staging,['apply','--3way','--binary','-'],patch);
 const untracked = previous ? git(root,['ls-files','--others','-z','--',scope]).toString().split('\\0').filter(Boolean) : [];
 for (const name of untracked) {
  if (!name.startsWith(scope+'/') || name.split('/').some(x=>x==='..'||x==='.git')) throw Error('Unsafe draft path; original workspace retained');
  const source=path.join(root,name), target=path.join(staging,name);
  if (!fs.lstatSync(source).isFile()) throw Error('Unsupported draft file; original workspace retained');
  if (fs.existsSync(target) && !fs.readFileSync(source).equals(fs.readFileSync(target))) throw Error('Draft conflicts with updated source; original workspace retained');
  fs.mkdirSync(path.dirname(target),{recursive:true}); fs.copyFileSync(source,target);
 }
 const commit=git(staging,['rev-parse','HEAD']).toString().trim();
 const changed=git(staging,['ls-files','-z','--',scope]).toString('base64');
 const backup=staging+'.previous';
 fs.renameSync(root,backup);
 try { fs.renameSync(staging,root); } catch(error) { fs.renameSync(backup,root); throw error; }
 fs.rmSync(backup,{recursive:true,force:true});
 process.stdout.write('__SYNARA_PREVIOUS_COMMIT__='+(previous || commit)+'\\n__SYNARA_CHECKOUT_COMMIT__='+commit+'\\n__SYNARA_CHECKOUT_MODE__=company\\n__SYNARA_CHANGED_FILES__='+changed+'\\n');
} catch(error) { fs.rmSync(staging,{recursive:true,force:true}); throw error; }
`;
  // The initial checkout emits its own markers; retain only the conversion's verified result.
  const cleanup = `require("node:fs").rmSync(${JSON.stringify(staging)},{recursive:true,force:true})`;
  const repositoryUrl = `${input.repositoryOrigin ?? input.binding.origin}/${input.binding.owner}/${input.binding.repository}.git`;
  const remount = hydrateLfs(root, input.binding.path, repositoryUrl, input.binding.origin, input.credentialConfigPath, input.mountRoot);
  return { cwd: `${root}/${input.binding.path}`, command: `if ! ( ${checkout.command} ) >/dev/null; then node -e ${quote(cleanup)}; exit 1; fi; ${uncoverLfs(root, input.binding.path, input.mountRoot)}; if ! node -e ${quote(script)}; then ${input.mountRoot ? `${remount} >/dev/null 2>&1 || true;` : ""} exit 1; fi; ${input.mountRoot ? remount : ":"}` };
}

/** Local commits are still unpublished drafts; move their delta onto the verified company base. */
export function makeVerifiedRepositoryRefreshPlan(input: Parameters<typeof makeRepositoryRefreshPlan>[0] & {
  readonly verifiedCommit?: string | undefined;
}) {
  const refresh = makeRepositoryRefreshPlan(input);
  if (!input.companyOnly || !input.verifiedCommit) return refresh;
  const migrate = makeRepositoryIsolationPlan(input);
  const root = input.checkoutRoot ?? REPOSITORY_CHECKOUT_ROOT;
  return { cwd: refresh.cwd, command: `if [ "$(git -C ${quote(root)} rev-parse HEAD)" != ${quote(input.verifiedCommit)} ]; then ${migrate.command}; else ${refresh.command}; fi` };
}
