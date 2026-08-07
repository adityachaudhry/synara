import type { ProjectReadFileInput } from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { GiteaCompanyCatalogError } from "../giteaProjects/Errors";
import { readWorkspaceFileWithRepositoryFallback } from "./readWorkspaceFile";
import { WorkspaceFileSystemError } from "./Services/WorkspaceFileSystem";

const input: ProjectReadFileInput = {
  cwd: "/data/gitea-company-projects/nth",
  relativePath: "technical_diligence.md",
};

const missingLocalFile = new WorkspaceFileSystemError({
  cwd: input.cwd,
  relativePath: input.relativePath,
  operation: "workspaceFileSystem.realpath",
  detail: "ENOENT",
});

describe("readWorkspaceFileWithRepositoryFallback", () => {
  it("returns a successful local read without opening the repository", async () => {
    const result = await Effect.runPromise(
      readWorkspaceFileWithRepositoryFallback(input, {
        readLocal: () =>
          Effect.succeed({
            relativePath: "technical_diligence.md",
            contents: "local contents",
            truncated: false,
          }),
        openRepositoryFile: () =>
          Effect.die(new Error("A successful local read must not access Gitea.")),
      }),
    );

    expect(result).toEqual({
      relativePath: "technical_diligence.md",
      contents: "local contents",
      truncated: false,
    });
  });

  it("reads and truncates a uniquely resolved bound repository file", async () => {
    const result = await Effect.runPromise(
      readWorkspaceFileWithRepositoryFallback(
        { ...input, maxBytes: 5 },
        {
          readLocal: () => Effect.fail(missingLocalFile),
          openRepositoryFile: () =>
            Effect.succeed(
              Option.some({
                relativePath: "analysis/technical_diligence.md",
                fileName: "technical_diligence.md",
                response: new Response("abcdef"),
              }),
            ),
        },
      ),
    );

    expect(result).toEqual({
      relativePath: "analysis/technical_diligence.md",
      contents: "abcde",
      truncated: true,
    });
  });

  it("preserves the original local failure for an unbound workspace", async () => {
    const failure = await Effect.runPromise(
      readWorkspaceFileWithRepositoryFallback(input, {
        readLocal: () => Effect.fail(missingLocalFile),
        openRepositoryFile: () => Effect.succeed(Option.none()),
      }).pipe(Effect.flip),
    );

    expect(failure).toBe(missingLocalFile);
  });

  it("rejects binary repository bytes on the text preview path", async () => {
    const failure = await Effect.runPromise(
      readWorkspaceFileWithRepositoryFallback(input, {
        readLocal: () => Effect.fail(missingLocalFile),
        openRepositoryFile: () =>
          Effect.succeed(
            Option.some({
              relativePath: "analysis/technical_diligence.md",
              fileName: "technical_diligence.md",
              response: new Response(new Uint8Array([65, 0, 66])),
            }),
          ),
      }).pipe(Effect.flip),
    );

    expect(failure).toMatchObject({
      _tag: "WorkspaceFileSystemError",
      operation: "workspaceFileSystem.readFile",
      detail: "File appears to be binary.",
    });
  });

  it("surfaces a bound repository transport failure", async () => {
    const repositoryFailure = new GiteaCompanyCatalogError({
      operation: "fetch",
      detail: "Gitea request failed with HTTP 503.",
    });
    const failure = await Effect.runPromise(
      readWorkspaceFileWithRepositoryFallback(input, {
        readLocal: () => Effect.fail(missingLocalFile),
        openRepositoryFile: () => Effect.fail(repositoryFailure),
      }).pipe(Effect.flip),
    );

    expect(failure).toBe(repositoryFailure);
  });
});
