import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

const SafeRepositoryIdentifier = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u),
);

const SafeGitRef = TrimmedNonEmptyString.check(
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

const GiteaOrigin = TrimmedNonEmptyString.check(
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

export const GiteaCompanySlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
);
export type GiteaCompanySlug = typeof GiteaCompanySlug.Type;

const GiteaCompanyPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^companies\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
);

export const GiteaSubdirectoryProjectBinding = Schema.Struct({
  kind: Schema.Literal("gitea-subdirectory"),
  origin: GiteaOrigin,
  owner: SafeRepositoryIdentifier,
  repository: SafeRepositoryIdentifier,
  ref: SafeGitRef,
  path: GiteaCompanyPath,
});
export type GiteaSubdirectoryProjectBinding = typeof GiteaSubdirectoryProjectBinding.Type;

export const ProjectRepositoryBinding = GiteaSubdirectoryProjectBinding;
export type ProjectRepositoryBinding = typeof ProjectRepositoryBinding.Type;

export const GiteaCompanyProjectDescriptor = Schema.Struct({
  companyId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  companyName: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  companySlug: GiteaCompanySlug,
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  binding: GiteaSubdirectoryProjectBinding,
});
export type GiteaCompanyProjectDescriptor = typeof GiteaCompanyProjectDescriptor.Type;

export const GiteaCompanyCatalogSnapshot = Schema.Struct({
  available: Schema.Boolean,
  projects: Schema.Array(GiteaCompanyProjectDescriptor),
  diagnostics: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(1_024))),
  refreshedAt: IsoDateTime,
});
export type GiteaCompanyCatalogSnapshot = typeof GiteaCompanyCatalogSnapshot.Type;
