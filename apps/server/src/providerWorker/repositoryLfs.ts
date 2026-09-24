/** Run inside the worker: enumerate only this company's pointers and use Gitea's LFS batch API. */
export function repositoryLfsScript(input: {
  readonly checkoutRoot: string;
  readonly companyPath: string;
  readonly repositoryUrl: string;
  readonly sourceOrigin: string;
  readonly credentialConfigPath?: string;
  readonly mountRoot?: string;
  readonly onlyPath?: string;
}) {
  return `
const fs = require("node:fs"), cp = require("node:child_process"), path = require("node:path"), crypto = require("node:crypto");
const { Readable, Transform } = require("node:stream"), { pipeline } = require("node:stream/promises");
const config = ${JSON.stringify(input)};
if (config.onlyPath && (!config.onlyPath.startsWith(config.companyPath + "/") || config.onlyPath.split("/").some(part => !part || part === "." || part === ".."))) throw Error("Invalid company LFS preview path");
const run = (args, stdin) => cp.execFileSync("git", ["-C", config.checkoutRoot, ...args], { input: stdin, maxBuffer: 64 * 1024 * 1024 });
const credential = config.credentialConfigPath ? fs.readFileSync(config.credentialConfigPath, "utf8").match(/extraHeader = Authorization: ([^\\r\\n]+)/)?.[1] : undefined;
const entries = run(["ls-tree", "-r", "-z", "HEAD", "--", config.companyPath]).toString().split("\\0").filter(Boolean).map(line => {
  const tab = line.indexOf("\\t"), parts = line.slice(0, tab).split(" ");
  return { type: parts[1], oid: parts[2], name: line.slice(tab + 1) };
}).filter(file => file.type === "blob" && (!config.onlyPath || file.name === config.onlyPath));
const sizes = run(["cat-file", "--batch-check=%(objectsize)"], entries.map(file => file.oid + "\\n").join("")).toString().trim().split("\\n");
const candidates = entries.filter((file, index) => Number(sizes[index]) <= 1024);
const objects = run(["cat-file", "--batch"], candidates.map(file => file.oid + "\\n").join(""));
let offset = 0;
const files = [];
for (const file of candidates) {
  const end = objects.indexOf(10, offset), size = Number(objects.toString("utf8", offset, end).split(" ")[2]);
  const pointer = objects.toString("utf8", end + 1, end + 1 + size);
  offset = end + size + 2;
  if (!pointer.startsWith("version https://git-lfs.github.com/spec/v1\\n")) continue;
  const oid = pointer.match(/^oid sha256:([a-f0-9]{64})$/m)?.[1], length = pointer.match(/^size ([0-9]+)$/m)?.[1];
  if (!oid || !length) throw Error("Invalid company LFS pointer: " + file.name);
  files.push({ name: file.name, oid, pointerOid: file.oid, size: Number(length), pointer });
}
async function matches(target, file) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.size !== file.size) return false;
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
    return hash.digest("hex") === file.oid;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function updateAttributes() {
  const attributes = files.map(file => {
    const pattern = "/" + file.name.split("").map(char => ["*", "?", "["].includes(char) ? "[" + char + "]" : char).join("");
    return JSON.stringify(pattern) + " filter=lfs diff=lfs merge=lfs -text";
  });
  const target = path.join(config.checkoutRoot, ".git", "info", "attributes");
  const previous = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const text = config.onlyPath ? previous + (previous && !previous.endsWith("\\n") ? "\\n" : "") + attributes.filter(line => !previous.split("\\n").includes(line)).map(line => line + "\\n").join("") : attributes.join("\\n") + "\\n";
  if (previous !== text) fs.writeFileSync(target, text);
  return previous !== text;
}
(async () => {
  if (config.mountRoot) {
    // The Gitea LFS pointer remains under each bind mount. The bytes stay in
    // Gitea's native S3 backend and are read through the root-owned FUSE mount.
    const unescapeMount = value => value.replace(/\\\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
    const readMounts = () => fs.readFileSync("/proc/self/mountinfo", "utf8").trim().split("\\n").map(line => {
      const fields = line.split(" ");
      return { device: fields[2], root: unescapeMount(fields[3]), target: unescapeMount(fields[4]), options: fields[5].split(","), type: fields[fields.indexOf("-") + 1], source: fields[fields.indexOf("-") + 2] };
    });
    const mounts = readMounts();
    const storageMounts = mounts.filter(mount => mount.target === config.mountRoot), storageMount = storageMounts[0];
    const supportedFilesystem = (storageMount?.type === "fuse.s3fs" && storageMount.source === "s3fs") || (storageMount?.type === "fuse" && storageMount.source === "mountpoint-s3");
    if (storageMounts.length !== 1 || !supportedFilesystem || !storageMount.options.includes("ro") || !fs.statSync(config.mountRoot).isDirectory()) throw Error("Company S3 LFS mount is unavailable");
    const bindingsMatch = mounts => {
      const currentMounts = new Map(mounts.map(mount => [mount.target, mount]));
      const scopedMounts = mounts.filter(mount => config.onlyPath ? mount.target === path.join(config.checkoutRoot, config.onlyPath) : mount.target.startsWith(path.join(config.checkoutRoot, config.companyPath) + "/"));
      return files.length > 0 && scopedMounts.length === files.length && files.every(file => {
        const mounted = currentMounts.get(path.join(config.checkoutRoot, file.name));
        const source = path.join(storageMount.root, file.oid.slice(0, 2), file.oid.slice(2, 4), file.oid.slice(4));
        return mounted?.device === storageMount.device && mounted.type === storageMount.type && mounted.source === storageMount.source && mounted.root === source && mounted.options.includes("ro");
      });
    };
    // Reuse requires the live filesystem identity, not a marker restored from disk.
    if (!bindingsMatch(mounts)) {
      ${repositoryS3LfsUnmountScript(input.checkoutRoot, input.companyPath, input.onlyPath)}
      if (!config.onlyPath) cp.execFileSync("chown", ["-R", "10001:10001", path.join(config.checkoutRoot, config.companyPath)]);
      const execFile = require("node:util").promisify(cp.execFile);
      const mountOne = async file => {
        const source = path.join(config.mountRoot, file.oid.slice(0, 2), file.oid.slice(2, 4), file.oid.slice(4));
        const sourceStat = await fs.promises.stat(source);
        if (!sourceStat.isFile() || sourceStat.size !== file.size) throw Error("Gitea S3 LFS object unavailable: " + file.name);
        const target = path.join(config.checkoutRoot, file.name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (fs.existsSync(target)) {
          const stat = fs.lstatSync(target);
          if (!stat.isFile()) throw Error("Company LFS path is not a regular file: " + file.name);
          if (stat.size > 1024) {
            if (!await matches(target, file)) throw Error("Local company binary edits preserved without overwrite: " + file.name);
            fs.writeFileSync(target, file.pointer);
          } else if (fs.readFileSync(target, "utf8") !== file.pointer) {
            throw Error("Local company binary edits preserved without overwrite: " + file.name);
          }
        } else {
          fs.writeFileSync(target, file.pointer);
        }
        await execFile("mount", ["--bind", source, target]);
      };
      for (let index = 0; index < files.length; index += 8) {
        const results = await Promise.allSettled(files.slice(index, index + 8).map(mountOne));
        const failed = results.find(result => result.status === "rejected");
        if (failed) throw failed.reason;
      }
      if (files.length && !bindingsMatch(readMounts())) throw Error("Company S3 LFS bindings must match their read-only source");
    }
    updateAttributes();
    for (let index = 0; index < files.length; index += 100) {
      run(["update-index", "--assume-unchanged", "--", ...files.slice(index, index + 100).map(file => file.name)]);
    }
    process.stdout.write("__SYNARA_LFS_VERIFIED__=" + files.length + "\\n");
    return;
  }
  const pending = [];
  for (const file of files) {
    const target = path.join(config.checkoutRoot, file.name);
    if (await matches(target, file)) continue;
    if (fs.existsSync(target) && (fs.lstatSync(target).size > 1024 || fs.readFileSync(target, "utf8") !== file.pointer)) {
      throw Error("Company binary has local edits; preserved without overwrite: " + file.name);
    }
    pending.push(file);
  }
  const unique = Array.from(new Map(pending.map(file => [file.oid, file])).values());
  const downloads = new Map();
  for (let index = 0; index < unique.length; index += 100) {
    const batch = unique.slice(index, index + 100);
    const response = await fetch(config.repositoryUrl + "/info/lfs/objects/batch", {
      method: "POST", signal: AbortSignal.timeout(120000),
      headers: { Accept: "application/vnd.git-lfs+json", "Content-Type": "application/vnd.git-lfs+json", ...(credential ? { Authorization: credential } : {}) },
      body: JSON.stringify({ operation: "download", transfers: ["basic"], objects: batch.map(({ oid, size }) => ({ oid, size })) }),
    });
    if (!response.ok) throw Error("Company LFS batch request failed: " + response.status);
    const result = await response.json();
    for (const object of result.objects ?? []) downloads.set(object.oid, object);
  }
  async function materialize(file) {
    const object = downloads.get(file.oid), action = object?.actions?.download;
    if (object?.error || !action?.href || object.size !== file.size) throw Error("Company LFS object unavailable: " + file.name);
    const url = new URL(action.href), repository = new URL(config.repositoryUrl), origin = repository.origin;
    if (url.origin === config.sourceOrigin && url.origin !== origin) {
      url.protocol = repository.protocol;
      url.host = repository.host;
    }
    if (url.protocol !== "https:" && url.origin !== origin) throw Error("Company LFS download URL is not trusted.");
    const response = await fetch(url, {
      signal: AbortSignal.timeout(120000),
      headers: { ...(credential && url.origin === origin ? { Authorization: credential } : {}), ...(action.header ?? {}) },
    });
    if (!response.ok || !response.body) throw Error("Company LFS download failed: " + response.status);
    const target = path.join(config.checkoutRoot, file.name), temporary = target + ".synara-lfs-" + crypto.randomUUID();
    let size = 0;
    const hash = crypto.createHash("sha256");
    try {
      await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
        size += chunk.length; hash.update(chunk); done(size > file.size ? Error("Company LFS object exceeded declared size") : null, chunk);
      }}), fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      if (size !== file.size || hash.digest("hex") !== file.oid) throw Error("Company LFS content mismatch: " + file.name);
      fs.renameSync(temporary, target);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  for (let index = 0; index < pending.length; index += 4) await Promise.all(pending.slice(index, index + 4).map(materialize));
  for (const file of files) if (!await matches(path.join(config.checkoutRoot, file.name), file)) throw Error("Company LFS verification failed: " + file.name);
  // Gitea stores pointer blobs even in repositories without tracked LFS attributes.
  // Declare only verified pointer paths so native Git's packaged clean filter preserves their identity.
  const attributesChanged = updateAttributes();
  if (files.length && (pending.length || attributesChanged)) {
    const names = files.map(file => file.name);
    run(["diff", "--cached", "--quiet", "HEAD", "--", ...names]);
    for (const file of files) {
      const normalized = run(["hash-object", "--path=" + file.name, path.join(config.checkoutRoot, file.name)]).toString().trim();
      if (normalized !== file.pointerOid) throw Error("The installed LFS filter could not round-trip: " + file.name);
    }
    // Refresh stat information only for verified files whose normalized blob is exactly HEAD.
    run(["add", "--renormalize", "--", ...names]);
    run(["diff", "--cached", "--quiet", "HEAD", "--", ...names]);
  }
  process.stdout.write("__SYNARA_LFS_VERIFIED__=" + files.length + "\\n");
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;
}

/** Uncover local pointers before Git changes the tree. The S3 FUSE mount stays up. */
export function repositoryS3LfsUnmountScript(checkoutRoot: string, companyPath: string, onlyPath?: string) {
  return `
const fs=require("node:fs"),cp=require("node:child_process");
const root=${JSON.stringify(checkoutRoot)}, scope=${JSON.stringify(companyPath)};
const onlyPath=${JSON.stringify(onlyPath)};
const prefix=root+"/"+scope+"/";
const targets=fs.readFileSync("/proc/self/mountinfo","utf8").split("\\n").filter(Boolean)
  .map(line=>{const fields=line.split(" "), separator=fields.indexOf("-");return {
    target:fields[4].replace(/\\\\([0-7]{3})/g,(_,code)=>String.fromCharCode(parseInt(code,8))),
    mountpoint:fields[separator+1]==="fuse" && fields[separator+2]==="mountpoint-s3"
  };})
  .filter(({target})=>onlyPath ? target===root+"/"+onlyPath : target.startsWith(prefix)).sort((a,b)=>b.target.length-a.target.length);
for(const {target,mountpoint} of targets) {
  if(mountpoint) {
    // ponytail: retired binds stay root-only until sandbox teardown; idle teardown bounds their lifetime.
    const detached="/root/.synara-detached-lfs";
    fs.mkdirSync(detached,{recursive:true,mode:0o700});
    const placeholder=detached+"/"+require("node:crypto").randomUUID();
    fs.writeFileSync(placeholder,"",{flag:"wx",mode:0o600});
    cp.execFileSync("mount",["--move",target,placeholder]);
  } else cp.execFileSync("umount",[target]);
}
if(targets.length){
  cp.execFileSync("git",["-C",root,"update-index","--no-assume-unchanged","--",...targets.map(({target})=>target.slice(root.length+1))]);
}
`;
}
