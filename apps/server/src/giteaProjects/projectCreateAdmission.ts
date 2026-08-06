import type {
  ClientOrchestrationCommand,
  GiteaCompanyProjectDescriptor,
  ProjectRepositoryBinding,
} from "@synara/contracts";
import { Effect } from "effect";

type ProjectCreateCommand = Extract<ClientOrchestrationCommand, { type: "project.create" }>;

export function canonicalizeGiteaProjectCreate<E>(
  command: ClientOrchestrationCommand,
  resolveBinding: (
    binding: ProjectRepositoryBinding,
  ) => Effect.Effect<GiteaCompanyProjectDescriptor, E>,
): Effect.Effect<ClientOrchestrationCommand, E> {
  if (command.type !== "project.create" || command.repositoryBinding == null) {
    return Effect.succeed(command);
  }
  return resolveBinding(command.repositoryBinding).pipe(
    Effect.map(
      (descriptor): ProjectCreateCommand => ({
        ...command,
        title: descriptor.companyName,
        workspaceRoot: descriptor.workspaceRoot,
        createWorkspaceRootIfMissing: true,
        repositoryBinding: descriptor.binding,
      }),
    ),
  );
}
