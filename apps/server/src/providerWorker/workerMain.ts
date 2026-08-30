import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Duration, Effect, FileSystem, Layer, Stream } from "effect";
import { Socket } from "effect/unstable/socket";
import WebSocket from "ws";

import { ServerConfig, type ServerConfigShape } from "../config";
import { makePiAdapterLive } from "../provider/Layers/PiAdapter";
import { PiAdapter } from "../provider/Services/PiAdapter";
import { ProviderWorkerTransportError } from "./Errors";
import type { ProviderWorkerSocket } from "./providerWorkerConnection";
import { makeProviderWorkerClientSession } from "./workerClientSession";
import {
  PROVIDER_WORKER_CONFIG_PATH,
  readAndConsumeProviderWorkerConfigFile,
} from "./workerConfig";
import { makeProviderWorkerOutbox } from "./workerOutbox";
import { makeProviderWorkerRequestLedger } from "./workerRequestLedger";
import { getProviderWorkerReleaseProvenance } from "./releaseProvenance";

function makeWorkerServerConfig(
  config: ReturnType<typeof resolveProviderWorkerConfig>,
): ServerConfigShape {
  const stateDir = `${config.homeDir}/state`;
  const logsDir = `${stateDir}/logs`;
  return {
    mode: "web",
    port: 0,
    host: undefined,
    cwd: config.cwd,
    homeDir: config.homeDir,
    chatWorkspaceRoot: config.cwd,
    studioWorkspaceRoot: `${config.cwd}/Studio`,
    baseDir: config.homeDir,
    stateDir,
    secretsDir: `${stateDir}/secrets`,
    dbPath: `${stateDir}/state.sqlite`,
    settingsPath: `${stateDir}/settings.json`,
    keybindingsConfigPath: `${stateDir}/keybindings.json`,
    worktreesDir: `${config.homeDir}/worktrees`,
    attachmentsDir: `${stateDir}/attachments`,
    logsDir,
    serverLogPath: `${logsDir}/worker.log`,
    serverRuntimeStatePath: `${stateDir}/runtime.json`,
    quitResumeStatePath: `${stateDir}/quit-resume.json`,
    providerLogsDir: `${logsDir}/provider`,
    providerEventLogPath: `${logsDir}/provider/events.log`,
    terminalLogsDir: `${logsDir}/terminal`,
    anonymousIdPath: `${stateDir}/anonymous-id`,
    environmentIdPath: `${stateDir}/environment-id`,
    staticDir: undefined,
    devUrl: undefined,
    publicUrl: undefined,
    allowInsecureRemote: false,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logProviderEvents: false,
    logWebSocketEvents: false,
  };
}

const makeClientSocket = Effect.fn(function* (
  url: string,
): Effect.fn.Return<ProviderWorkerSocket, ProviderWorkerTransportError, never> {
  const socket = yield* Socket.makeWebSocket(url).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderWorkerTransportError({
          operation: "connect",
          detail: "Failed to open the provider worker control socket.",
          cause,
        }),
    ),
  );
  const write = yield* socket.writer;
  return {
    run: (handler, onOpen) =>
      socket
        .runRaw(handler, { ...(onOpen === undefined ? {} : { onOpen }) })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderWorkerTransportError({
                operation: "read",
                detail: "Provider worker control socket closed.",
                cause,
              }),
          ),
        ),
    sendRaw: (frame) =>
      write(frame).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderWorkerTransportError({
              operation: "write",
              detail: "Failed to send a provider worker frame.",
              cause,
            }),
        ),
      ),
    close: (code, reason) => write(new Socket.CloseEvent(code, reason)).pipe(Effect.ignore),
  };
});

const main = Effect.gen(function* () {
  yield* Effect.logInfo("provider worker booting", {
    ...config.safeDescription,
    ...getProviderWorkerReleaseProvenance(),
  });
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(config.homeDir, { recursive: true });
  yield* fileSystem.makeDirectory(config.cwd, { recursive: true });
  const adapter = yield* PiAdapter;
  yield* Effect.logInfo("provider worker adapter ready", config.safeDescription);
  const fence = {
    sandboxId: config.sandboxId,
    workerId: config.workerId,
    lifecycleGeneration: config.lifecycleGeneration,
  };
  const outbox = makeProviderWorkerOutbox(fence);
  const requestLedger = makeProviderWorkerRequestLedger({ fence, adapter });
  let publishEvent = (event: Parameters<typeof outbox.push>[0]) =>
    Effect.try({
      try: () => {
        outbox.push(event);
      },
      catch: (cause) => cause,
    }).pipe(Effect.orDie);

  yield* Stream.runForEach(adapter.streamEvents, (event) => publishEvent(event)).pipe(
    Effect.forkScoped,
  );

  let reconnectAttempt = 0;
  while (true) {
    let retired = false;
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.logInfo("provider worker connecting", config.safeDescription);
        const socket = yield* makeClientSocket(config.controlUrl);
        const session = makeProviderWorkerClientSession({
          fence,
          adapter,
          outbox,
          requestLedger,
          socket,
        });
        publishEvent = session.publishEvent;
        yield* session.run;
        retired = session.isRetired();
      }),
    ).pipe(Effect.result);
    publishEvent = (event) =>
      Effect.try({ try: () => { outbox.push(event); }, catch: (cause) => cause }).pipe(
        Effect.orDie,
      );
    if (retired) return;
    reconnectAttempt += 1;
    const delayMs = Math.min(10_000, 500 * 2 ** Math.min(reconnectAttempt, 5));
    yield* Effect.logWarning("provider worker reconnecting", {
      ...config.safeDescription,
      attempt: reconnectAttempt,
      delayMs,
      result: result._tag,
    });
    yield* Effect.sleep(Duration.millis(delayMs));
  }
});

const configPath =
  process.env.SYNARA_PROVIDER_WORKER_CONFIG_PATH?.trim() || PROVIDER_WORKER_CONFIG_PATH;
const config = readAndConsumeProviderWorkerConfigFile(configPath);
const workerConfigLayer = Layer.succeed(ServerConfig, makeWorkerServerConfig(config));
const piLayer = makePiAdapterLive().pipe(
  Layer.provide(workerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const workerWebSocketLayer = Layer.succeed(
  Socket.WebSocketConstructor,
  (url, protocols) =>
    (protocols === undefined
      ? new WebSocket(url, {
          headers: { Authorization: `Bearer ${config.bootstrapCredential}` },
        })
      : new WebSocket(url, protocols, {
          headers: { Authorization: `Bearer ${config.bootstrapCredential}` },
        })) as unknown as globalThis.WebSocket,
);

NodeRuntime.runMain(
  main.pipe(
    Effect.provide(piLayer),
    Effect.provide(workerWebSocketLayer),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);
