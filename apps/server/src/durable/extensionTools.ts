/**
 * Tools that the Pi coding agent received through extensions, rebuilt as Pi Durable tools.
 *
 * - Web access keeps the pi-web-access implementation; only its tool registrations are used.
 * - Crunchbase connects to its MCP server directly instead of through pi-mcp-adapter.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JsonValue } from "@earendil-works/chord";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { TSchema } from "typebox";

import { lazyModule } from "../lazyModule.ts";

type PiExtensionTool = {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: unknown) => void) | undefined,
    ctx: unknown,
  ): Promise<{ content?: unknown; details?: unknown }>;
};

type ToolContent = NonNullable<Awaited<ReturnType<ToolRegistration["execute"]>>["content"]>;

const toJson = (value: unknown): JsonValue | undefined => {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return undefined;
  }
};

const toContent = (content: unknown): ToolContent => {
  if (!Array.isArray(content)) return [{ type: "text", text: JSON.stringify(content ?? null) }];
  return content.flatMap((item): ToolContent => {
    if (item && typeof item === "object" && item.type === "text" && typeof item.text === "string") {
      return [{ type: "text", text: item.text }];
    }
    if (item && typeof item === "object" && item.type === "image" && typeof item.data === "string") {
      return [{ type: "image", data: item.data, mimeType: String(item.mimeType ?? "image/png") }];
    }
    return [];
  });
};

/** Runs a Pi coding-agent extension factory and keeps only its tools. */
async function collectExtensionTools(factory: (pi: unknown) => unknown): Promise<PiExtensionTool[]> {
  const tools: PiExtensionTool[] = [];
  const noop = () => undefined;
  const api: Record<string, unknown> = {
    registerTool: (tool: PiExtensionTool) => tools.push(tool),
    events: { on: noop, emit: noop },
    exec: async () => ({ stdout: "", stderr: "unavailable", code: 1, killed: false }),
    getFlag: () => undefined,
  };
  const proxy = new Proxy(api, { get: (target, key) => (key in target ? target[key as string] : noop) });
  await factory(proxy);
  return tools;
}

const extensionContext = (cwd: string) =>
  new Proxy(
    { cwd, hasUI: false, model: undefined, modelRegistry: undefined, scopedModels: [], sessionManager: undefined },
    {
      get: (target, key) =>
        key in target
          ? target[key as keyof typeof target]
          : key === "ui"
            ? new Proxy({}, { get: () => async () => undefined })
            : undefined,
    },
  );

const loadPiWebAccess = lazyModule(() => import("pi-web-access/index.ts"));

/** Web search and fetch tools. Searches go to Perplexity, as configured for the old worker. */
export async function createWebAccessTools(): Promise<ToolRegistration[]> {
  const { default: factory } = await loadPiWebAccess();
  const tools = await collectExtensionTools(factory as (pi: unknown) => unknown);
  return tools.map((tool) =>
    defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      replay: "safe",
      execute: async (args, api, context) => {
        const result = await tool.execute(api.callId, args, context.abortSignal, undefined, extensionContext("/workspace"));
        const details = toJson(result.details);
        return { content: toContent(result.content), ...(details === undefined ? {} : { details }) };
      },
    }) as unknown as ToolRegistration,
  );
}

const CRUNCHBASE_TOOLS = new Set(["crunchbase_search", "crunchbase_company_profile", "crunchbase_founder_profile"]);

/** Crunchbase MCP tools, when the controller has the Glasswing Crunchbase connection. */
export async function createCrunchbaseTools(): Promise<ToolRegistration[]> {
  const url = process.env.GLASSWING_CRUNCHBASE_MCP_URL?.trim();
  const token = process.env.GLASSWING_CRUNCHBASE_MCP_TOKEN?.trim();
  if (!url || !token) return [];
  let connected: Promise<Client> | undefined;
  const connect = () => {
    connected ??= (async () => {
      const client = new Client({ name: "synara-durable", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
      return client;
    })().catch((cause) => {
      connected = undefined;
      throw cause;
    });
    return connected;
  };
  const listed = await (await connect()).listTools();
  return listed.tools
    .filter((tool) => CRUNCHBASE_TOOLS.has(tool.name))
    .map((tool) =>
      defineTool({
        name: tool.name,
        description: tool.description ?? tool.name,
        parameters: tool.inputSchema as unknown as TSchema,
        replay: "safe",
        execute: async (args) => {
          const client = await connect();
          const result = await client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, undefined, {
            timeout: 60_000,
          });
          const content = toContent(result.content);
          if (result.isError === true) {
            throw new Error(content.map((item) => (item.type === "text" ? item.text : "")).join("\n") || "Crunchbase call failed.");
          }
          return { content };
        },
      }) as unknown as ToolRegistration,
    );
}
