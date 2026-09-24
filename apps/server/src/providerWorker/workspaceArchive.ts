import { randomUUID } from "node:crypto";
import path from "node:path";
import { Effect } from "effect";
import type { WorkspaceRuntimeBinding, WorkspaceRuntimeShape } from "../workspaceRuntime/Services/WorkspaceRuntime.ts";
import { artifactApiClient } from "./artifactPublisher.ts";
import { REPOSITORY_CHECKOUT_ROOT } from "./repositoryCheckout.ts";
import type { ProviderWorkerRuntimeBinding } from "./runtimeBinding.ts";
import { S3_LFS_MOUNT_ROOT } from "./s3LfsMount.ts";
export type WorkspaceArchiveRuntime = Pick<WorkspaceRuntimeShape, "create" | "exec" | "writeFile" | "destroy">;

export const WORKSPACE_ARCHIVE_ROOTS = ["workspace", "root/.pi/agent/sessions"] as const;
export interface WorkspaceArchive {
  readonly archiveId: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly revision: string;
  readonly roots: readonly string[];
  readonly format: "tar-gzip-v1";
}
interface ArchiveRecord {
  archive_id: string;
  sha256: string;
  size_bytes: number;
  revision: string;
  roots: string[];
  format: string;
  download_url?: string;
}
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const attemptSync = <T>(run: () => T) => Effect.try({ try: run, catch: (cause) => cause });
const attempt = <T>(run: () => Promise<T>) => Effect.tryPromise({ try: run, catch: (cause) => cause });

function scope(binding: ProviderWorkerRuntimeBinding, revision: string) {
  const companyPath = (binding.repositoryCheckout?.binding ?? binding.repositoryUnavailable?.binding)?.path;
  if (!binding.threadId || !companyPath || !/^companies\/[a-z0-9][a-z0-9-]*$/u.test(companyPath) || !revision) {
    throw new Error("Workspace archive requires a company, thread, and immutable revision.");
  }
  return { company_slug: companyPath.slice("companies/".length), thread_id: binding.threadId, revision };
}
function verified(record: ArchiveRecord, expected: WorkspaceArchive) {
  if (!/^[0-9a-f]{64}$/u.test(expected.sha256) || !Number.isSafeInteger(expected.sizeBytes) ||
      expected.sizeBytes < 1 || expected.sizeBytes > 2 * 1024 ** 3 || expected.format !== "tar-gzip-v1" ||
      JSON.stringify(expected.roots) !== JSON.stringify(WORKSPACE_ARCHIVE_ROOTS) || record.archive_id !== expected.archiveId || record.sha256 !== expected.sha256 ||
      record.size_bytes !== expected.sizeBytes || record.revision !== expected.revision ||
      record.format !== expected.format || JSON.stringify(record.roots) !== JSON.stringify(WORKSPACE_ARCHIVE_ROOTS)) {
    throw new Error("Workspace archive metadata did not match the saved revision.");
  }
}
function signedUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Workspace archive transfer requires a signed HTTPS URL.");
  }
  return value;
}

// Executed inside the idle live workspace, isolated reader, or fresh destination.
// The coordinator holds the lifecycle lock and handles archive metadata.
// Use stdlib tar parsing and explicit extraction so validation is independent of Python versions.
const transferScript = String.raw`
import os,sys,json,tarfile,gzip,hashlib,shutil,posixpath,stat,urllib.request,subprocess,re,io
cfg=json.load(open(sys.argv[1])); action=sys.argv[2]; folder=os.path.dirname(sys.argv[1])
archive=folder+'/workspace.tar.gz'; decoded=folder+'/workspace.tar'
roots=['workspace','root/.pi/agent/sessions']; max_gzip=2*1024**3; max_decoded=8*1024**3
excluded=cfg['excluded']; max_entries=100000

def inside(name):
 return any(name==r or name.startswith(r+'/') for r in roots)
def allowed(name):
 return inside(name) and not any(name==r or name.startswith(r+'/') for r in excluded)
def clean(name):
 if not name or name.startswith('/') or '\\' in name or any(c in name for c in ['\x00','\n','\r']): raise ValueError('unsafe archive path')
 name=name.rstrip('/')
 if any(p in ('','.','..') for p in name.split('/')) or not allowed(name): raise ValueError('archive path outside allowed roots')
 return name
def link_target(member):
 target=member.linkname
 if not target or target.startswith('/') or '\\' in target or any(c in target for c in ['\x00','\n','\r']): raise ValueError('unsafe archive link')
 target=posixpath.normpath(posixpath.join(posixpath.dirname(member.name),target)) if member.issym() else target
 return clean(target)
def check_member(member):
 member.name=clean(member.name)
 if not (member.isfile() or member.isdir() or member.issym() or member.islnk()) or member.size<0 or member.size>max_decoded or member.sparse is not None: raise ValueError('unsupported archive entry')
 if member.issym() or member.islnk(): link_target(member)
 return member

def workspace_mounts():
 # Read the kernel's mount table, never infer a canonical file from its size alone.
 def unescape(value): return re.sub(r'\\([0-7]{3})',lambda m:chr(int(m[1],8)),value)
 mounts=[]
 with open('/proc/self/mountinfo') as source:
  for line in source:
   fields=line.rstrip('\n').split(' '); split=fields.index('-')
   mounts.append({'id':fields[0],'device':fields[2],'root':unescape(fields[3]),'target':unescape(fields[4]),
    'options':fields[5].split(','),'type':fields[split+1],'source':unescape(fields[split+2]),'super':fields[split+3].split(',')})
 bases=[m for m in mounts if m['target']==cfg['mountRoot']]
 base=bases[0] if len(bases)==1 else None
 targets={}
 for mount in mounts:
  name=mount['target'].lstrip('/')
  if not allowed(name): continue
  if name in targets: raise ValueError('stacked workspace mounts cannot be archived')
  if not base or (base['type'],base['source']) not in (('fuse.s3fs','s3fs'),('fuse','mountpoint-s3')) or \
     'ro' not in base['options'] or 'user_id=0' not in base['super'] or mount['type']!=base['type'] or \
     'ro' not in mount['options'] or mount['device']!=base['device'] or mount['source']!=base['source']:
   raise ValueError('unknown workspace mount cannot be archived')
  targets[name]=mount
 return base,targets

def mounted_pointers(base,mounts):
 if not mounts: return {}
 root=cfg['checkoutRoot']; company=cfg['companyPath']; prefix=root+'/'+company+'/'
 if any(not ('/'+name).startswith(prefix) for name in mounts): raise ValueError('LFS mount outside company checkout')
 def git(args,data=None):
  return subprocess.run(['git','-c','safe.directory='+root,'-C',root,*args],input=data,stdout=subprocess.PIPE,
   stderr=subprocess.PIPE,check=True,env={**os.environ,'GIT_NO_LAZY_FETCH':'1','GIT_TERMINAL_PROMPT':'0','GIT_CONFIG_GLOBAL':'/dev/null'}).stdout
 entries={}
 for entry in git(['ls-tree','-r','-z','HEAD','--',company]).split(b'\0'):
  if not entry: continue
  header,name=entry.split(b'\t',1); mode,kind,oid=header.split(b' ')
  archive_name=(root+'/'+os.fsdecode(name)).lstrip('/')
  if archive_name in mounts:
   if kind!=b'blob' or mode not in (b'100644',b'100755'): raise ValueError('LFS mount has no regular Git pointer')
   entries[archive_name]=oid
 if set(entries)!=set(mounts): raise ValueError('LFS mount has no tracked Git pointer')
 request=b''.join(oid+b'\n' for oid in entries.values())
 sizes=git(['cat-file','--batch-check=%(objectsize)'],request).splitlines()
 if len(sizes)!=len(entries) or any(not value.isdigit() or int(value)>1024 for value in sizes): raise ValueError('LFS mount has no small Git pointer')
 blobs=io.BytesIO(git(['cat-file','--batch'],request)); pointers={}
 for name,oid in entries.items():
  header=blobs.readline().rstrip(b'\n').split(b' ')
  if len(header)!=3 or header[0]!=oid or header[1]!=b'blob': raise ValueError('invalid LFS pointer object')
  pointer=blobs.read(int(header[2]))
  if blobs.read(1)!=b'\n' or not pointer.startswith(b'version https://git-lfs.github.com/spec/v1\n'): raise ValueError('invalid LFS pointer')
  digest=re.search(rb'^oid sha256:([0-9a-f]{64})$',pointer,re.M); length=re.search(rb'^size ([0-9]+)$',pointer,re.M)
  if not digest or not length: raise ValueError('invalid LFS pointer')
  sha=digest[1].decode(); expected=posixpath.join(base['root'],sha[:2],sha[2:4],sha[4:])
  if mounts[name]['root']!=expected: raise ValueError('LFS mount does not match its Git pointer')
  pointers[name]=pointer
 return pointers

def inventory(mounts):
 entries={}
 def visit(name):
  if not allowed(name): return
  clean(name)
  if len(entries)>=max_entries: raise ValueError('excessive archive entries')
  # The kernel mount identity is stable; avoid even getattr against canonical S3 objects.
  if name in mounts:
   entries[name]=('canonical-mount',)
   return
  info=os.lstat('/'+name)
  entries[name]=(info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink,info.st_size,
   info.st_mtime_ns,info.st_ctime_ns,os.readlink('/'+name) if stat.S_ISLNK(info.st_mode) else None)
  if stat.S_ISDIR(info.st_mode):
   for child in sorted(os.listdir('/'+name)): visit(name+'/'+child)
 for root in roots:
  if os.path.lexists('/'+root):
   if os.path.islink('/'+root) or not os.path.isdir('/'+root): raise ValueError('archive root must be a directory')
   visit(root)
 return entries

def unpack_checked(extract):
 with gzip.open(archive,'rb') as source, open(decoded,'xb') as target:
  total=0
  while True:
   block=source.read(1024*1024)
   if not block: break
   total+=len(block)
   if total>max_decoded: raise ValueError('decoded archive exceeds limit')
   target.write(block)
 decoded_size=os.path.getsize(decoded)
 with tarfile.open(decoded,'r:') as tar:
  members={}; total=0
  for member in tar:
   check_member(member)
   if member.offset_data+member.size>decoded_size: raise ValueError('truncated archive entry')
   if member.name in members or len(members)>=max_entries: raise ValueError('duplicate or excessive archive entries')
   members[member.name]=member; total+=member.size
   if total>max_decoded: raise ValueError('archive payload exceeds limit')
  for member in members.values():
   parent=posixpath.dirname(member.name)
   while parent:
    if parent in members and not members[parent].isdir(): raise ValueError('non-directory archive ancestor')
    parent=posixpath.dirname(parent)
   if member.islnk():
    target=members.get(link_target(member))
    if target is None or not target.isfile(): raise ValueError('hard link must reference a regular archive file')
  if extract:
   # No live worker may use this destination. Refuse any existing data or symlink ancestor.
   for root in roots:
    current='/'
    for part in root.split('/'):
     current=os.path.join(current,part)
     if os.path.lexists(current) and (os.path.islink(current) or not os.path.isdir(current)): raise ValueError('unsafe destination ancestor')
    destination='/'+root
    if os.path.isdir(destination) and os.listdir(destination): raise ValueError('archive restoration requires fresh empty roots')
   for root in roots: os.makedirs('/'+root,mode=0o700,exist_ok=True)
   for member in members.values():
    if member.isdir(): os.makedirs('/'+member.name,mode=0o700,exist_ok=True)
   for member in members.values():
    destination='/'+member.name
    os.makedirs(os.path.dirname(destination),mode=0o700,exist_ok=True)
    if member.isfile():
     with tar.extractfile(member) as source, open(destination,'xb') as target: shutil.copyfileobj(source,target,1024*1024)
     os.chmod(destination,member.mode & 0o777); os.utime(destination,(member.mtime,member.mtime))
   # Links are installed after files; validated links never become extraction ancestors.
   for member in members.values():
    if member.issym(): os.symlink(member.linkname,'/'+member.name)
    elif member.islnk(): os.link('/'+link_target(member),'/'+member.name)
   for member in sorted(members.values(),key=lambda m:len(m.name),reverse=True):
    if member.isdir(): os.chmod('/'+member.name,member.mode & 0o777); os.utime('/'+member.name,(member.mtime,member.mtime))
 os.unlink(decoded)

class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): raise ValueError('archive transfer redirect rejected')
opener=urllib.request.build_opener(NoRedirect())

def digest():
 size=os.path.getsize(archive)
 if size<1 or size>max_gzip: raise ValueError('compressed archive exceeds limit')
 h=hashlib.sha256()
 with open(archive,'rb') as source:
  for block in iter(lambda:source.read(1024*1024),b''): h.update(block)
 return {'sha256':h.hexdigest(),'sizeBytes':size}

if action=='pack':
 mounts=workspace_mounts(); before=inventory(mounts[1]); pointers=mounted_pointers(*mounts)
 count=0; payload=0
 def selected(member):
  global count,payload
  if not allowed(member.name): return None
  check_member(member); count+=1; payload+=member.size
  if count>max_entries or payload>max_decoded: raise ValueError('workspace archive exceeds limit')
  return member
 class LimitedWriter:
  def __init__(self,stream,limit): self.stream=stream; self.limit=limit; self.count=0
  def write(self,data):
   self.count+=len(data)
   if self.count>self.limit: raise ValueError('archive stream exceeds limit')
   return self.stream.write(data)
  def tell(self): return self.count
  def flush(self): return self.stream.flush()
 with open(archive,'xb') as target:
  with gzip.GzipFile(fileobj=LimitedWriter(target,max_gzip),mode='wb',compresslevel=1,mtime=0) as zipped:
   with tarfile.open(fileobj=LimitedWriter(zipped,max_decoded),mode='w|',dereference=False) as tar:
    for name in before:
     if name in pointers:
      # Preserve the underlying Git pointer without opening the mounted S3 binary.
      member=tarfile.TarInfo(name); member.size=len(pointers[name]); member.mode=0o644
      member.uid=member.gid=10001; member.mtime=0
      tar.addfile(selected(member),io.BytesIO(pointers[name]))
     else: tar.add('/'+name,arcname=name,filter=selected,recursive=False)
 if workspace_mounts()!=mounts or inventory(mounts[1])!=before: raise ValueError('workspace changed during archive capture')
 metadata=digest(); unpack_checked(False); print(json.dumps(metadata))
elif action=='upload':
 metadata=digest()
 if metadata!=cfg['metadata']: raise ValueError('workspace archive changed before upload')
 headers={**cfg['headers'],'Content-Length':str(metadata['sizeBytes'])}
 with open(archive,'rb') as source:
  with opener.open(urllib.request.Request(cfg['url'],data=source,headers=headers,method='PUT'),timeout=300) as response:
   if response.status not in (200,201,204): raise ValueError('archive upload rejected')
elif action=='restore':
 total=0
 with opener.open(urllib.request.Request(cfg['url']),timeout=300) as response, open(archive,'xb') as target:
  while True:
   block=response.read(1024*1024)
   if not block: break
   total+=len(block)
   if total>max_gzip or total>cfg['metadata']['sizeBytes']: raise ValueError('archive download exceeds limit')
   target.write(block)
 if digest()!=cfg['metadata']: raise ValueError('workspace archive checksum mismatch')
 unpack_checked(True)
else: raise ValueError('unknown transfer action')
`;

const run = Effect.fn(function* (runtime: WorkspaceArchiveRuntime, workspace: WorkspaceRuntimeBinding,
  folder: string, binding: ProviderWorkerRuntimeBinding, action: string, extra: Record<string, unknown> = {}) {
  const excluded = ["opt/synara/provider-worker.json", "tmp/synara-repository-credential.gitconfig",
    path.posix.join(binding.homeDir, "state/secrets").replace(/^\//u, "")];
  if (action === "pack") excluded.push(path.posix.join(binding.homeDir, "state/logs").replace(/^\//u, ""));
  yield* runtime.writeFile(workspace, { path: `${folder}/config.json`, mode: 0o600,
    data: JSON.stringify({ excluded, checkoutRoot: REPOSITORY_CHECKOUT_ROOT, mountRoot: S3_LFS_MOUNT_ROOT,
      companyPath: (binding.repositoryCheckout?.binding ?? binding.repositoryUnavailable?.binding)?.path, ...extra }) });
  const result = yield* runtime.exec(workspace, {
    command: `python3 ${quote(`${folder}/transfer.py`)} ${quote(`${folder}/config.json`)} ${quote(action)}`,
    timeoutSeconds: 600,
  });
  // Never copy Python network exceptions or signed URLs into controller logs.
  if (result.exitCode !== 0 || result.timedOut || result.truncated) {
    return yield* Effect.fail(new Error(`Workspace archive ${action} failed in sandbox (exit ${result.exitCode}).`));
  }
  return result.stdout;
});
const prepare = Effect.fn(function* (runtime: WorkspaceArchiveRuntime, workspace: WorkspaceRuntimeBinding, folder: string) {
  const created = yield* runtime.exec(workspace, { command: `mkdir -m 700 ${quote(folder)}`, timeoutSeconds: 10 });
  if (created.exitCode !== 0) return yield* Effect.fail(new Error("Cannot prepare workspace archive transfer."));
  yield* runtime.writeFile(workspace, { path: `${folder}/transfer.py`, data: transferScript, mode: 0o600 });
});

/** Hold the lifecycle lock and settle/stop the worker first; concurrent disk writes fail capture. */
export const archiveWorkspace = Effect.fn(function* (input: {
  readonly workspaceRuntime: WorkspaceArchiveRuntime;
  readonly binding: ProviderWorkerRuntimeBinding;
  readonly revision: string;
}) {
  const api = yield* attemptSync(() => artifactApiClient());
  if (!api) return yield* Effect.fail(new Error("Workspace archive API is not configured."));
  const identity = yield* attemptSync(() => scope(input.binding, input.revision));
  const runtime = input.workspaceRuntime;
  const reader = input.binding.workspace;
  const folder = `/tmp/synara-workspace-archive-${randomUUID()}`;
  return yield* Effect.gen(function* () {
    yield* prepare(runtime, reader, folder);
    const output = yield* run(runtime, reader, folder, input.binding, "pack");
    const metadata = yield* attemptSync(() => {
      const value = JSON.parse(output) as { sha256: string; sizeBytes: number };
      if (!/^[0-9a-f]{64}$/u.test(value.sha256) || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > 2 * 1024 ** 3) throw new Error("Invalid archive manifest.");
      return value;
    });
    const grant = yield* attempt(() => api<{ archive_id: string; upload_url: string; headers: Record<string, string> }>(
      "/internal/workspace-archives/grants", { ...identity, sha256: metadata.sha256, size_bytes: metadata.sizeBytes,
        format: "tar-gzip-v1", roots: WORKSPACE_ARCHIVE_ROOTS }));
    const url = yield* attemptSync(() => signedUrl(grant.upload_url));
    yield* run(runtime, reader, folder, input.binding, "upload", { metadata, url, headers: grant.headers });
    const archive: WorkspaceArchive = { archiveId: grant.archive_id, ...metadata, revision: input.revision,
      format: "tar-gzip-v1", roots: WORKSPACE_ARCHIVE_ROOTS };
    const record = yield* attempt(() => api<ArchiveRecord>(`/internal/workspace-archives/${encodeURIComponent(archive.archiveId)}/complete`, identity));
    yield* attemptSync(() => verified(record, archive));
    return archive;
  }).pipe(Effect.ensuring(runtime.exec(reader, {
    command: `rm -rf -- ${quote(folder)}`, timeoutSeconds: 10,
  }).pipe(Effect.ignore)));
});

/** Retained for importing a Railway checkpoint through an isolated reader. */
export const archiveWorkspaceCheckpoint = Effect.fn(function* (input: {
  readonly workspaceRuntime: WorkspaceArchiveRuntime;
  readonly binding: ProviderWorkerRuntimeBinding;
  readonly checkpoint: { readonly id: string; readonly key: string };
}) {
  yield* attemptSync(() => {
    if (!artifactApiClient()) throw new Error("Workspace archive API is not configured.");
    scope(input.binding, input.checkpoint.key);
  });
  const runtime = input.workspaceRuntime;
  return yield* Effect.acquireUseRelease(
    runtime.create({ lifecycleGeneration: randomUUID(), checkpointName: input.checkpoint.key,
      environment: {}, networkIsolation: "ISOLATED", maintenance: true }),
    (reader) => archiveWorkspace({ workspaceRuntime: runtime, binding: { ...input.binding, workspace: reader }, revision: input.checkpoint.key }),
    (reader) => runtime.destroy(reader).pipe(Effect.catch((cause) => Effect.logWarning("workspace archive reader cleanup failed", { runtimeId: reader.runtimeId, cause }))),
  );
});

/** Only call before provisioning or launching any worker in a fresh prepared sandbox. */
export const restoreWorkspaceArchive = Effect.fn(function* (input: {
  readonly workspaceRuntime: WorkspaceArchiveRuntime;
  readonly workspace: WorkspaceRuntimeBinding;
  readonly binding: ProviderWorkerRuntimeBinding;
  readonly archive: WorkspaceArchive;
}) {
  const api = yield* attemptSync(() => artifactApiClient());
  if (!api) return yield* Effect.fail(new Error("Workspace archive API is not configured."));
  const identity = yield* attemptSync(() => scope(input.binding, input.archive.revision));
  const record = yield* attempt(() => api<ArchiveRecord>(`/internal/workspace-archives/${encodeURIComponent(input.archive.archiveId)}?${new URLSearchParams(identity)}`));
  const url = yield* attemptSync(() => { verified(record, input.archive); return signedUrl(record.download_url!); });
  const runtime = input.workspaceRuntime;
  const folder = `/tmp/synara-workspace-archive-${randomUUID()}`;
  yield* Effect.gen(function* () {
    yield* prepare(runtime, input.workspace, folder);
    yield* run(runtime, input.workspace, folder, input.binding, "restore", {
      metadata: { sha256: input.archive.sha256, sizeBytes: input.archive.sizeBytes }, url,
    });
  }).pipe(Effect.ensuring(runtime.exec(input.workspace, {
    command: `rm -rf -- ${quote(folder)}`, timeoutSeconds: 10,
  }).pipe(Effect.ignore)));
});
