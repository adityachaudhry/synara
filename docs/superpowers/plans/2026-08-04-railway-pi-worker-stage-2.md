# Railway Pi Worker — Stage 2 Implementation Plan

**Goal:** Make the browser-hosted Synara server able to run one Pi provider session in a sticky Railway Sandbox while preserving the existing in-process Pi adapter as the default.

**Non-goals:** Electron/Desktop integration, replacing Synara's orchestration primitives, sharing the control-plane database with workers, or treating a sandbox checkpoint as durable application state.

## Evidence behind the transport choice

- A `PRIVATE` Railway Sandbox can reach other services in its project environment over Railway private networking.
- Railway documents stable private DNS for services, not a stable inbound DNS name for each experimental sandbox.
- The live `v4` trial proved a detached direct Node process can survive the creating CLI and be reattached by durable session name.
- A shell-wrapped detached process failed during reattachment; the worker must be launched as a direct Node entry point.

Therefore the sandbox worker opens an authenticated outbound WebSocket to the Synara control plane. The browser continues to use Synara's existing public WebSocket. Provider commands travel down the worker socket and canonical `ProviderRuntimeEvent` objects travel back up it.

## Reused Synara primitives

- The worker hosts the existing `PiAdapter`; it does not implement a second Pi integration.
- The control plane exposes a `RemotePiAdapter` implementing the existing `ProviderAdapterShape`.
- `ProviderService`, `ProviderCommandReactor`, and `ProviderRuntimeIngestion` remain unchanged consumers.
- `ProviderSessionDirectory.adapterKey` selects `pi:local` or `pi:railway-sandbox` for a sticky thread.
- `ProviderSessionDirectory.runtimePayload` stores the sandbox ID, durable exec session name, worker ID, and worker protocol version.
- Existing provider session and runtime event repositories remain the durable orchestration source of truth.

## Security boundary

- Railway API credentials remain in the Synara server only.
- Each provisioned worker gets a random, single-runtime bootstrap credential. The server stores only its digest after registration.
- The worker socket is authenticated before registration and fenced by sandbox ID plus lifecycle generation.
- The worker receives only an allowlisted provider credential environment and worker bootstrap values. It never receives database, SuperTokens, Synara owner-session, or Railway API credentials.
- Worker protocol errors are structured and redacted; stdout/stderr are diagnostic metadata, not user-visible event transport.

## Task 1 — Schema-only worker protocol

Add worker protocol schemas under `packages/contracts`. Cover:

- protocol version and worker registration;
- request/response correlation;
- the Pi adapter methods Synara currently exposes;
- canonical provider runtime events;
- heartbeat and graceful retirement;
- explicit generation/runtime fencing on every envelope.

Write decoding tests first. Reject unknown methods, mismatched versions, malformed IDs, and oversized/unknown envelopes before transport code exists.

## Task 2 — Connection registry and request broker

Add a server service that:

- registers exactly one live connection for `(sandboxId, lifecycleGeneration)`;
- rejects duplicate/stale registrations;
- correlates bounded in-flight requests with timeouts;
- publishes worker events to a bounded queue;
- fails outstanding calls on disconnect;
- supports reconnect without replaying already acknowledged responses.

Build it against an injected connection shape first; WebSocket is an adapter to this service, not the service itself.

## Task 3 — Authenticated worker WebSocket route

Add a dedicated internal route, separate from browser RPC. The route:

- accepts only worker protocol frames;
- validates bootstrap credential, sandbox ID, worker ID, and lifecycle generation;
- registers the upgraded socket in the broker;
- applies Synara's existing WebSocket size bound;
- does not negotiate browser compatibility or create an owner browser session.

The worker URL is configurable and defaults on Railway to the Synara service's private DNS URL. No public worker URL is required.

## Task 4 — Worker artifact delivery and durable process lifecycle

Extend `RailwaySandboxClient` behind generic operations for:

- writing the built worker artifact and a non-secret manifest;
- launching the Node worker directly as a durable exec;
- returning and reattaching by durable session name;
- terminating the durable process during retirement.

Build a separate bundled `pi-worker.mjs` entry. It constructs the existing `PiAdapter` with Node services and worker-local `ServerConfig`, then connects to the control plane and translates protocol requests to adapter calls.

The generic lifecycle smoke remains provider-neutral. Worker readiness is a separate protocol-level smoke.

## Task 5 — Remote Pi adapter and sticky routing

Implement `RemotePiAdapter` as a proxy over the request broker. Add a composite Pi adapter that:

- reads `providers.pi.executionTarget` only when creating a new binding;
- persists `pi:local` or `pi:railway-sandbox` after successful session start;
- routes every later call by persisted adapter key;
- merges local and remote runtime-event streams;
- never silently falls back from remote to local after a remote session has been selected.

On restart, reconnect to the persisted sandbox and durable worker session before restoring the Pi session from its existing resume cursor. If the sandbox is gone, surface a recoverable runtime error and provision a new generation only through the existing session recovery path.

## Task 6 — Workspace materialization

Add a `WorkspaceMaterializer` boundary. First implementation:

- creates a worker-local checkout directory;
- clones/fetches a configured project Git remote when present;
- otherwise uploads a bounded workspace snapshot through the Railway files API;
- excludes Synara state, credentials, dependency caches, and ignored files;
- returns the sandbox-local cwd used in the existing `ProviderSessionStartInput`.

Git remains the source of truth for code. Synara's database remains the source of truth for orchestration. Object storage can later hold large attachment/workspace blobs, but it is not a coordination bus.

## Task 7 — Browser settings and observability

Expose the existing Pi execution-target setting in the browser with:

- Local (default) and Railway Sandbox options;
- server-reported configured/unconfigured state without secrets;
- thread runtime placement, provisioning/reconnecting/running/error status;
- an explicit note that changing the default affects new Pi sessions, not already-bound threads.

No Electron code is changed.

## Task 8 — Verification ladder

1. Protocol codec and broker unit tests.
2. Fake-worker adapter contract tests.
3. Local worker subprocess round trip using the real bundled Pi adapter without a model call.
4. One live `v4` sandbox worker registration, request, reconnect, and exact cleanup.
5. One real Pi session/turn from the browser when provider credentials are available in the server environment.
6. Disconnect/restart test proving persisted placement and generation fencing.
7. Focused contracts/server/web tests and browser/server production build.

Every live Railway attempt is appended to `docs/distributed-runtime/railway-v4-trial-log.md`, including failed artifact, auth, networking, credential, and reconnect attempts.
