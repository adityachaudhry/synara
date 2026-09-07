/** Run inside the worker: enumerate only this company's pointers and use Gitea's LFS batch API. */
export function repositoryLfsScript(input: {
  readonly checkoutRoot: string;
  readonly companyPath: string;
  readonly repositoryUrl: string;
  readonly credentialConfigPath?: string;
}) {
  return `
const fs = require("node:fs"), cp = require("node:child_process"), path = require("node:path"), crypto = require("node:crypto");
const { Readable, Transform } = require("node:stream"), { pipeline } = require("node:stream/promises");
const config = ${JSON.stringify(input)};
const run = (args, stdin) => cp.execFileSync("git", ["-C", config.checkoutRoot, ...args], { input: stdin, maxBuffer: 64 * 1024 * 1024 });
const credential = config.credentialConfigPath ? fs.readFileSync(config.credentialConfigPath, "utf8").match(/extraHeader = Authorization: ([^\\r\\n]+)/)?.[1] : undefined;
const entries = run(["ls-tree", "-r", "-z", "HEAD", "--", config.companyPath]).toString().split("\\0").filter(Boolean).map(line => {
  const tab = line.indexOf("\\t"), parts = line.slice(0, tab).split(" ");
  return { type: parts[1], oid: parts[2], name: line.slice(tab + 1) };
}).filter(file => file.type === "blob");
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
(async () => {
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
    const url = new URL(action.href), origin = new URL(config.repositoryUrl).origin;
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
  const attributes = files.map(file => {
    const pattern = "/" + file.name.split("").map(char => ["*", "?", "["].includes(char) ? "[" + char + "]" : char).join("");
    return JSON.stringify(pattern) + " filter=lfs diff=lfs merge=lfs -text";
  });
  const attributesPath = path.join(config.checkoutRoot, ".git", "info", "attributes"), attributesText = attributes.join("\\n") + "\\n";
  const attributesChanged = !fs.existsSync(attributesPath) || fs.readFileSync(attributesPath, "utf8") !== attributesText;
  if (attributesChanged) fs.writeFileSync(attributesPath, attributesText);
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
