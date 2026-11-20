import { Effect, Logger } from "effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "./config";
import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "./privatePathPermissions";

export const ServerLoggerLive = Effect.gen(function* () {
  const { logsDir, serverLogPath } = yield* ServerConfig;

  yield* Effect.sync(() => {
    ensurePrivateDirectorySync(logsDir);
    ensurePrivateFileSync(serverLogPath);
  });

  const fileLogger = Logger.formatSimple.pipe(Logger.toFile(serverLogPath));

  // On Railway every output line becomes its own log entry: one JSON object per line keeps a
  // structured log (and its fields) together. Local and desktop runs keep the readable format.
  const consoleLogger = process.env.RAILWAY_ENVIRONMENT_NAME ? Logger.consoleJson : Logger.defaultLogger;
  return Logger.layer([consoleLogger, fileLogger], {
    mergeWithExisting: false,
  });
}).pipe(Layer.unwrap);
