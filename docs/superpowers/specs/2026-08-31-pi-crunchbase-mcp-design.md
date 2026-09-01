# Pi Crunchbase MCP Design

## Goal

Give every Glasswing-hosted Pi session the existing read-only Crunchbase tools through `pi-mcp-adapter`, while keeping Crunchbase API behavior and credentials owned by `glasswing-ai-2`.

## Boundaries

- `glasswing-ai-2` owns Crunchbase request logic, `CRUNCHBASE_API_KEY`, and an authenticated Streamable HTTP MCP endpoint.
- Synara owns Pi extension loading only. It receives an MCP URL and bearer token from the host and does not contain Crunchbase API logic.
- The Railway provider worker receives only the MCP URL and bearer token; it never receives `CRUNCHBASE_API_KEY`.
- The endpoint exposes only `crunchbase_search`, `crunchbase_company_profile`, and `crunchbase_founder_profile`.
- No generic plugin catalog, configuration UI, official Crunchbase OAuth flow, or additional MCP server is added in this change.

## Runtime Flow

1. The Glasswing API mounts a token-protected, stateless Streamable HTTP MCP application that delegates to the existing Python Crunchbase integration functions.
2. The local Glasswing launcher creates an ephemeral bearer token and a second HTTPS callback tunnel for that MCP endpoint.
3. The launcher forwards `GLASSWING_CRUNCHBASE_MCP_URL` and `GLASSWING_CRUNCHBASE_MCP_TOKEN` to Synara and its distributed provider worker.
4. Synara loads `pi-mcp-adapter@2.31.0` with Pi `0.84.4` as an extension when both variables exist. The adapter eagerly discovers the three direct tools, keeps their existing names, and lazily performs data calls through the Glasswing MCP endpoint.
5. A Pi turn calls Crunchbase over MCP; Glasswing makes the API-key-authenticated Crunchbase request and returns normalized Markdown.

Provider-worker artifacts are gzipped once on the Synara host, uploaded as a self-contained archive, and expanded with the sandbox's guaranteed Node runtime. Railway provisioning relies on its operation-specific checkout, upload, connection, and request failures rather than one wall-clock deadline spanning every launch phase.

## Failure Behavior

- If neither MCP variable exists, generic Synara Pi behavior is unchanged.
- If exactly one variable exists, Pi session startup fails with a clear configuration error.
- Invalid bearer tokens receive HTTP 401 without invoking a Crunchbase handler.
- Crunchbase API failures return MCP tool errors and remain visible in the transcript.
- Provider startup diagnostics retain full causes in server logs, while transcript activities receive only the user-facing error detail.

## Acceptance

The real local Workspace is the acceptance environment. In a fresh Pi thread, an explicit Crunchbase request must render a successful Crunchbase tool call and return live company data. No unit tests are added per the user's instruction.
