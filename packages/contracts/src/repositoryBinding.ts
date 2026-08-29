import { Schema } from "effect";

const SafeRepositoryIdentifierPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

export const RepositoryIdentifier = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(SafeRepositoryIdentifierPattern),
);

export const GitRef = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(255),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u),
).check(
  Schema.makeFilter(
    (value) =>
      !value.includes("..") &&
      !value.includes("//") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.includes("@{"),
  ),
);

export const RepositoryOrigin = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "" &&
        url.pathname === "/" &&
        url.origin === value
      );
    } catch {
      return false;
    }
  }),
);

export const RepositorySubdirectoryPath = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
  Schema.makeFilter((value) => {
    if (value.startsWith("/") || value.includes("\\") || value.toLowerCase().endsWith(".git")) {
      return false;
    }
    const segments = value.split("/");
    return (
      segments.join("/") === value &&
      segments.every(
        (segment) =>
          segment !== "." &&
          segment !== ".." &&
          SafeRepositoryIdentifierPattern.test(segment),
      )
    );
  }),
);

export const ProjectRepositoryBinding = Schema.Struct({
  kind: Schema.Literal("git-subdirectory"),
  origin: RepositoryOrigin,
  owner: RepositoryIdentifier,
  repository: RepositoryIdentifier,
  ref: GitRef,
  path: RepositorySubdirectoryPath,
});
export type ProjectRepositoryBinding = typeof ProjectRepositoryBinding.Type;

export const ExternalProjectKey = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
  Schema.makeFilter((value) => value.trim() === value),
);
export type ExternalProjectKey = typeof ExternalProjectKey.Type;
