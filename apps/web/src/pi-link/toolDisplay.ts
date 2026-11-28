/**
 * How Pi tool calls appear in Synara's activity feed: item types, titles and lifecycle data.
 * Shared by every Pi runtime so the UI renders tool calls the same way.
 */

function toolRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstStringValue(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

export function textFromToolResult(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result;
  }
  const record = toolRecord(result);
  if (!record) {
    return undefined;
  }
  const directText = firstStringValue(record, [
    "output",
    "stdout",
    "stderr",
    "text",
    "summary",
    "message",
    "error",
  ]);
  if (directText) {
    return directText;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const parts = content.flatMap((block) => {
    const blockRecord = toolRecord(block);
    return blockRecord?.type === "text" && typeof blockRecord.text === "string"
      ? [blockRecord.text]
      : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function toolResultForDisplay(result: unknown): unknown {
  const record = toolRecord(result);
  if (!record || !Array.isArray(record.content)) return result;
  const content = (record.content as unknown[]).map((block) => {
    const image = toolRecord(block);
    return image?.type === "image" && typeof image.data === "string"
      ? { type: "text", text: "[Image provided to the agent; preview omitted from activity.]" }
      : block;
  });
  return content.some((block, index) => block !== (record.content as unknown[])[index])
    ? { ...record, content }
    : result;
}

function toolExitCode(result: unknown): number | null | undefined {
  const record = toolRecord(result);
  if (!record) return undefined;
  const exitCode = record.exitCode;
  if (typeof exitCode === "number" && Number.isFinite(exitCode)) return exitCode;
  const code = record.code;
  if (typeof code === "number" && Number.isFinite(code)) return code;
  return null;
}

function toolRawOutput(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined) return undefined;
  const text = textFromToolResult(result);
  const exitCode = toolExitCode(result);
  if (typeof result === "string") {
    return { stdout: result, content: result };
  }
  if (result === null) {
    return {};
  }
  const record = toolRecord(result);
  if (!record) {
    return text ? { stdout: text, content: text } : undefined;
  }
  return {
    ...record,
    ...(text ? { stdout: text, content: text } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function toolPath(args: unknown): string | undefined {
  return firstStringValue(toolRecord(args), ["path", "filePath", "file", "relativePath"]);
}

function toolCommand(args: unknown): string | undefined {
  return firstStringValue(toolRecord(args), ["command", "cmd"]);
}

function toolSearchQuery(toolName: string, args: unknown): string | undefined {
  const record = toolRecord(args);
  if (!record) return undefined;
  if (toolName === "grep" || toolName === "find") {
    return firstStringValue(record, ["pattern", "query"]);
  }
  return firstStringValue(record, ["query", "pattern"]);
}

function toolEditEntries(args: unknown): ReadonlyArray<Record<string, unknown>> | undefined {
  const record = toolRecord(args);
  if (!record) return undefined;
  if (Array.isArray(record.edits)) {
    return record.edits.flatMap((edit) => {
      const editRecord = toolRecord(edit);
      return editRecord ? [editRecord] : [];
    });
  }
  const oldText = firstStringValue(record, ["oldText", "old_string", "oldString"]);
  const newText = firstStringValue(record, ["newText", "new_string", "newString"]);
  if (oldText !== undefined || newText !== undefined) {
    return [
      {
        ...(oldText !== undefined ? { oldText } : {}),
        ...(newText !== undefined ? { newText } : {}),
      },
    ];
  }
  return undefined;
}

export function toolItemType(toolName: string): "command_execution" | "file_change" | "dynamic_tool_call" | "web_search" {
  switch (toolName) {
    case "bash":
      return "command_execution";
    case "edit":
    case "write":
      return "file_change";
    case "grep":
    case "find":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

const clip = (value: string, max = 80) => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

function firstOf(args: unknown, keys: readonly string[]): { first?: string; more: number } {
  const record = toolRecord(args);
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return { first: value, more: 0 };
    if (Array.isArray(value)) {
      const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      if (items.length) return { first: items[0]!, more: items.length - 1 };
    }
  }
  return { more: 0 };
}

const withMore = (text: string, more: number) => (more > 0 ? `${text} (+${more} more)` : text);

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return clip(url, 60);
  }
};

/**
 * A plain-language title for a tool call, when we can write one: the model's own description of
 * a shell command, or a sentence built from a research tool's arguments. Undefined leaves the
 * title to `toolTitle` and the timeline's own labels.
 */
export function toolDescription(toolName: string, args: unknown): string | undefined {
  switch (toolName) {
    case "bash": {
      const description = firstStringValue(toolRecord(args), ["description"]);
      return description ? clip(description, 120) : undefined;
    }
    case "read": {
      const filePath = toolPath(args);
      const name = filePath?.split("/").filter(Boolean).at(-1);
      return name ? `Read ${clip(name, 80)}` : undefined;
    }
    case "web_search":
    case "perplexity_search": {
      const { first, more } = firstOf(args, ["query", "queries"]);
      return first ? withMore(`Searched the web: ${clip(first)}`, more) : undefined;
    }
    case "perplexity_ask": {
      const { first } = firstOf(args, ["question"]);
      return first ? `Asked Perplexity: ${clip(first)}` : undefined;
    }
    case "fetch_content": {
      const { first, more } = firstOf(args, ["url", "urls"]);
      return first ? withMore(`Opened ${hostOf(first)}`, more) : undefined;
    }
    case "get_search_content":
      return "Read saved search results";
    case "crunchbase_search": {
      const { first } = firstOf(args, ["query", "name", "q"]);
      return first ? `Searched Crunchbase: ${clip(first)}` : "Searched Crunchbase";
    }
    case "crunchbase_company_profile":
    case "crunchbase_founder_profile": {
      const { first } = firstOf(args, ["name", "query", "permalink", "identifier", "company", "person", "uuid"]);
      return first ? `Looked up ${clip(first, 60)} on Crunchbase` : "Looked up a profile on Crunchbase";
    }
    case "glasswing_run_diligence": {
      const mode = firstStringValue(toolRecord(args), ["mode"]) ?? "full";
      return `Started ${mode} diligence`;
    }
    case "glasswing_remember":
      return "Saved a point to company memory";
    default:
      return undefined;
  }
}

export function toolTitle(toolName: string, args: unknown): string {
  const described = toolDescription(toolName, args);
  if (described) return described;
  // A command without a description gets a generic title, so the timeline labels it from the
  // command ("Listed files", "Read market_pain.md") instead of showing the command itself.
  if (toolName === "bash") return "command execution";
  const filePath = toolPath(args);
  if (
    filePath &&
    (toolName === "read" || toolName === "edit" || toolName === "write" || toolName === "ls")
  ) {
    return `${toolName} ${filePath}`;
  }
  const query = toolSearchQuery(toolName, args);
  if (query && (toolName === "find" || toolName === "grep")) {
    return `${toolName} ${query}`;
  }
  return toolName;
}

export function toolLifecycleData(input: {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  partialResult?: unknown;
  isError?: boolean;
}): Record<string, unknown> {
  const { toolCallId, toolName, args } = input;
  const rawOutput = toolRawOutput(input.result ?? input.partialResult);
  const path = toolPath(args);
  const query = toolSearchQuery(toolName, args);
  const command = toolCommand(args);
  const edits = toolEditEntries(args);
  const content = toolRecord(args)?.content;
  const outputDetails = toolRecord(rawOutput?.details);
  const unifiedDiff = firstStringValue(outputDetails, ["diff"]);
  const base: Record<string, unknown> = {
    toolCallId,
    callId: toolCallId,
    toolName,
    name: toolName,
    tool: toolName,
    kind: toolName,
    args,
    input: args,
    rawInput: args,
    ...(rawOutput ? { rawOutput } : {}),
    ...(input.partialResult !== undefined ? { partialResult: input.partialResult } : {}),
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.isError !== undefined ? { isError: input.isError } : {}),
  };

  switch (toolName) {
    case "bash":
      return {
        ...base,
        kind: "execute",
        ...(command ? { command } : {}),
        ...(rawOutput?.exitCode !== undefined ? { exitCode: rawOutput.exitCode } : {}),
      };
    case "read":
      return {
        ...base,
        kind: "read",
        ...(path
          ? {
              path,
              filePath: path,
              files: [{ path }],
              commandActions: [{ type: "read", name: "read", path }],
            }
          : {}),
      };
    case "edit":
      return {
        ...base,
        kind: "edit",
        ...(path ? { path, filePath: path, files: [{ path }], changes: [{ path }] } : {}),
        ...(edits ? { edits: edits.map((edit) => ({ ...edit, ...(path ? { path } : {}) })) } : {}),
        ...(unifiedDiff ? { unifiedDiff } : {}),
      };
    case "write":
      return {
        ...base,
        kind: "write",
        ...(path ? { path, filePath: path, files: [{ path }], changes: [{ path }] } : {}),
        ...(typeof content === "string" ? { content } : {}),
      };
    case "find":
      return {
        ...base,
        kind: "search",
        searchKind: "find",
        ...(query ? { query } : {}),
        ...(path ? { path } : {}),
        ...(query || path
          ? { commandActions: [{ type: "search", name: "find", query, path }] }
          : {}),
      };
    case "grep":
      return {
        ...base,
        kind: "search",
        searchKind: "grep",
        ...(query ? { query } : {}),
        ...(path ? { path } : {}),
        ...(query || path
          ? { commandActions: [{ type: "search", name: "grep", query, path }] }
          : {}),
      };
    case "ls":
      return {
        ...base,
        kind: "listFiles",
        ...(path
          ? {
              path,
              query: path,
              commandActions: [{ type: "listFiles", name: "ls", path }],
            }
          : {}),
      };
    default:
      return base;
  }
}
