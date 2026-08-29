import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { admitRepositoryBinding } from "./repositoryBindingAdmission";

const policy = {
  allowedOrigins: ["https://git.example.com"],
  allowedOwners: ["acme-platform"],
} as const;

const validBinding = {
  kind: "git-subdirectory",
  origin: "https://git.example.com",
  owner: "acme-platform",
  repository: "company-data",
  ref: "main",
  path: "companies/cue-cloud",
} as const;

describe("admitRepositoryBinding", () => {
  it("returns the exact canonical binding when its origin and owner are allowed", async () => {
    await expect(Effect.runPromise(admitRepositoryBinding(validBinding, policy))).resolves.toEqual(
      validBinding,
    );
  });

  it.each([
    ["origin", { ...validBinding, origin: "https://evil.example.com" }, "not-allowed"],
    ["owner", { ...validBinding, owner: "other-owner" }, "not-allowed"],
    ["repository", { ...validBinding, repository: "../company-data" }, "invalid"],
    ["ref", { ...validBinding, ref: "-dangerous" }, "invalid"],
    ["path", { ...validBinding, path: "companies/../secrets" }, "invalid"],
  ])("rejects an unapproved %s", async (field, binding, reason) => {
    const exit = await Effect.runPromiseExit(admitRepositoryBinding(binding, policy));

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toMatchObject({
        _tag: "RepositoryBindingAdmissionError",
        field,
        reason,
      });
    }
  });
});
