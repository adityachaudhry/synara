import type {
  GiteaCompanyCatalogSnapshot,
  GiteaCompanyProjectDescriptor,
  ProjectRepositoryBinding,
} from "@synara/contracts";
import { ServiceMap, type Effect, type Option } from "effect";

import type { GiteaCompanyCatalogError } from "../Errors";

export interface GiteaWorkspaceFile {
  readonly relativePath: string;
  readonly fileName: string;
  readonly response: Response;
}

export interface GiteaCompanyCatalogShape {
  readonly list: () => Effect.Effect<GiteaCompanyCatalogSnapshot, GiteaCompanyCatalogError>;
  readonly validateBinding: (
    binding: ProjectRepositoryBinding,
  ) => Effect.Effect<ProjectRepositoryBinding, GiteaCompanyCatalogError>;
  readonly resolveBinding: (
    binding: ProjectRepositoryBinding,
  ) => Effect.Effect<GiteaCompanyProjectDescriptor, GiteaCompanyCatalogError>;
  readonly openWorkspaceFile: (input: {
    readonly cwd: string;
    readonly relativePath: string;
  }) => Effect.Effect<Option.Option<GiteaWorkspaceFile>, GiteaCompanyCatalogError>;
}

export class GiteaCompanyCatalog extends ServiceMap.Service<
  GiteaCompanyCatalog,
  GiteaCompanyCatalogShape
>()("synara/giteaProjects/Services/GiteaCompanyCatalog") {}
