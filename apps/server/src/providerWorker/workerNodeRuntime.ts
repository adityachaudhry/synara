export const PROVIDER_WORKER_NODE_VERSION = "24.13.1";
export const PROVIDER_WORKER_NODE_BINARY_PATH = "/opt/node/bin/node";

const NODE_SHA256_BY_ARCH = {
  arm64: "c827d3d301e2eed1a51f36d0116b71b9e3d9e3b728f081615270ea40faac34c1",
  x64: "30215f90ea3cd04dfbc06e762c021393fa173a1d392974298bbc871a8e461089",
} as const;

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export function makeProviderWorkerNodeRuntimeCommand(): string {
  const expectedVersion = `v${PROVIDER_WORKER_NODE_VERSION}`;
  const runtimeRoot = "/opt/node";
  return [
    "set -eu",
    `if test -x ${shellQuote(PROVIDER_WORKER_NODE_BINARY_PATH)} && test "$(${shellQuote(PROVIDER_WORKER_NODE_BINARY_PATH)} --version)" = ${shellQuote(expectedVersion)}; then exit 0; fi`,
    `case "$(uname -m)" in x86_64) node_arch=x64; node_sha256=${NODE_SHA256_BY_ARCH.x64} ;; aarch64|arm64) node_arch=arm64; node_sha256=${NODE_SHA256_BY_ARCH.arm64} ;; *) echo "Unsupported provider worker architecture: $(uname -m)" >&2; exit 1 ;; esac`,
    'runtime_tmp="$(mktemp -d)"',
    `trap 'rm -rf "$runtime_tmp"' EXIT`,
    `curl -fsSL "https://nodejs.org/dist/v${PROVIDER_WORKER_NODE_VERSION}/node-v${PROVIDER_WORKER_NODE_VERSION}-linux-\${node_arch}.tar.xz" -o "$runtime_tmp/node.tar.xz"`,
    'printf "%s  %s\\n" "$node_sha256" "$runtime_tmp/node.tar.xz" | sha256sum -c -',
    `rm -rf ${shellQuote(runtimeRoot)}`,
    `mkdir -p ${shellQuote(runtimeRoot)}`,
    `tar -xJf "$runtime_tmp/node.tar.xz" --strip-components=1 -C ${shellQuote(runtimeRoot)}`,
    `test "$(${shellQuote(PROVIDER_WORKER_NODE_BINARY_PATH)} --version)" = ${shellQuote(expectedVersion)}`,
  ].join(" && ");
}
