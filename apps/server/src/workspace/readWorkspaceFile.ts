import { Buffer } from "node:buffer";

import type { ProjectReadFileInput } from "@synara/contracts";
import { Effect, Option } from "effect";

import type { GiteaCompanyCatalogShape } from "../giteaProjects/Services/GiteaCompanyCatalog";
import type { WorkspaceFileSystemShape } from "./Services/WorkspaceFileSystem";
import { WorkspaceFileSystemError } from "./Services/WorkspaceFileSystem";

const DEFAULT_READ_FILE_MAX_BYTES = 1_000_000;

function readResponsePrefix(input: {
  readonly response: Response;
  readonly maxBytes: number;
  readonly cwd: string;
  readonly relativePath: string;
}) {
  return Effect.tryPromise({
    try: async () => {
      const body = input.response.body;
      if (body === null) {
        return { bytes: Buffer.alloc(0), truncated: false };
      }
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let truncated = false;
      let finished = false;
      try {
        while (total <= input.maxBytes) {
          const next = await reader.read();
          if (next.done) {
            finished = true;
            break;
          }
          const remaining = input.maxBytes + 1 - total;
          const chunk = next.value.subarray(0, Math.max(0, remaining));
          if (chunk.byteLength > 0) {
            chunks.push(chunk);
            total += chunk.byteLength;
          }
          if (next.value.byteLength > chunk.byteLength || total > input.maxBytes) {
            truncated = true;
            break;
          }
        }
      } finally {
        if (!finished) {
          await reader.cancel().catch(() => undefined);
        }
      }
      const declaredLength = Number(input.response.headers.get("content-length") ?? "0");
      return {
        bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
        truncated:
          truncated || (Number.isFinite(declaredLength) && declaredLength > input.maxBytes),
      };
    },
    catch: (cause) =>
      new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation: "workspaceFileSystem.readFile",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
}

export function readWorkspaceFileWithRepositoryFallback(
  input: ProjectReadFileInput,
  dependencies: {
    readonly readLocal: WorkspaceFileSystemShape["readFile"];
    readonly openRepositoryFile: GiteaCompanyCatalogShape["openWorkspaceFile"];
  },
) {
  return dependencies.readLocal(input).pipe(
    Effect.catch((localError) =>
      dependencies
        .openRepositoryFile({ cwd: input.cwd, relativePath: input.relativePath })
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(localError),
              onSome: (file) =>
                readResponsePrefix({
                  response: file.response,
                  maxBytes: input.maxBytes ?? DEFAULT_READ_FILE_MAX_BYTES,
                  cwd: input.cwd,
                  relativePath: input.relativePath,
                }).pipe(
                  Effect.flatMap(({ bytes, truncated }) => {
                    if (bytes.includes(0)) {
                      return Effect.fail(
                        new WorkspaceFileSystemError({
                          cwd: input.cwd,
                          relativePath: input.relativePath,
                          operation: "workspaceFileSystem.readFile",
                          detail: "File appears to be binary.",
                        }),
                      );
                    }
                    const maxBytes = input.maxBytes ?? DEFAULT_READ_FILE_MAX_BYTES;
                    return Effect.succeed({
                      relativePath: file.relativePath,
                      contents: bytes.subarray(0, maxBytes).toString("utf8"),
                      truncated,
                    });
                  }),
                ),
            }),
          ),
        ),
    ),
  );
}
