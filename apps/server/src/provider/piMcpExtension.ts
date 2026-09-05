import type { InlineExtension } from "@earendil-works/pi-coding-agent";

import { lazyModule } from "../lazyModule.ts";

const MCP_URL_ENV = "GLASSWING_CRUNCHBASE_MCP_URL";
const MCP_TOKEN_ENV = "GLASSWING_CRUNCHBASE_MCP_TOKEN";
const CRUNCHBASE_TOOLS = [
  "crunchbase_search",
  "crunchbase_company_profile",
  "crunchbase_founder_profile",
] as const;

type PiMcpAdapterModule = typeof import("pi-mcp-adapter");

const loadPiMcpAdapter: () => Promise<PiMcpAdapterModule> = lazyModule(
  () => import("pi-mcp-adapter"),
);

function configuredConnection(): { readonly url: string; readonly token: string } | undefined {
  const rawUrl = process.env[MCP_URL_ENV]?.trim();
  const token = process.env[MCP_TOKEN_ENV]?.trim();
  if (!rawUrl && !token) return undefined;
  if (!rawUrl || !token) {
    throw new Error(`${MCP_URL_ENV} and ${MCP_TOKEN_ENV} must be configured together.`);
  }

  const url = new URL(rawUrl);
  const isLocal =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    (process.env.SYNARA_LOCAL_DOCKER === "1" && url.hostname === "host.docker.internal");
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new Error(`${MCP_URL_ENV} must use HTTPS, except for loopback development.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${MCP_URL_ENV} must not contain credentials, query, or fragment.`);
  }
  return { url: url.toString(), token };
}

export async function createGlasswingCrunchbaseMcpExtension(): Promise<
  InlineExtension | undefined
> {
  const connection = configuredConnection();
  if (!connection) return undefined;

  const { createMcpAdapter } = await loadPiMcpAdapter();
  return {
    name: "glasswing-crunchbase-mcp",
    factory: createMcpAdapter({
      config: {
        mcpServers: {
          crunchbase: {
            url: connection.url,
            headers: { Authorization: `Bearer ${connection.token}` },
            lifecycle: "eager",
            requestTimeoutMs: 60_000,
            protocolVersion: "auto",
            exposeResources: false,
            directTools: true,
            toolPrefix: "none",
            includeTools: [...CRUNCHBASE_TOOLS],
            approveTools: false,
          },
        },
        settings: {
          directTools: true,
          disableProxyTool: true,
          freezeDirectTools: true,
          scriptMode: false,
          showStatusIcon: false,
          mcpFooterStatus: "off",
        },
      },
    }),
  };
}
