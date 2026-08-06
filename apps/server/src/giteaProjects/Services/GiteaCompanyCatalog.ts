import type {
  GiteaCompanyCatalogSnapshot,
  GiteaCompanyProjectDescriptor,
  ProjectRepositoryBinding,
} from "@synara/contracts";
import { ServiceMap, type Effect } from "effect";

import type { GiteaCompanyCatalogError } from "../Errors";

export interface GiteaCompanyCatalogShape {
  readonly list: () => Effect.Effect<GiteaCompanyCatalogSnapshot, GiteaCompanyCatalogError>;
  readonly validateBinding: (
    binding: ProjectRepositoryBinding,
  ) => Effect.Effect<ProjectRepositoryBinding, GiteaCompanyCatalogError>;
  readonly resolveBinding: (
    binding: ProjectRepositoryBinding,
  ) => Effect.Effect<GiteaCompanyProjectDescriptor, GiteaCompanyCatalogError>;
}

export class GiteaCompanyCatalog extends ServiceMap.Service<
  GiteaCompanyCatalog,
  GiteaCompanyCatalogShape
>()("synara/giteaProjects/Services/GiteaCompanyCatalog") {}
