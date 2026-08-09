// FILE: glasswingProjectContext.ts
// Purpose: Resolves an embedding host's selected company to one Synara project.
// Layer: Web runtime adapter

export interface GlasswingProjectCandidate {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
}

export interface GlasswingHostProjectIdentity {
  readonly name: string;
  readonly slug: string;
}

function normalizeProjectIdentity(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function checkoutFolderName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() ?? "";
}

export function resolveGlasswingHostProject<T extends GlasswingProjectCandidate>(
  projects: readonly T[],
  hostProject: GlasswingHostProjectIdentity,
): T | null {
  const hostName = normalizeProjectIdentity(hostProject.name);
  const hostSlug = normalizeProjectIdentity(hostProject.slug);

  const nameMatch = projects.find(
    (project) => normalizeProjectIdentity(project.name) === hostName,
  );
  if (nameMatch) return nameMatch;

  return (
    projects.find((project) => {
      const projectName = normalizeProjectIdentity(project.name);
      const folderName = normalizeProjectIdentity(checkoutFolderName(project.cwd));
      return projectName === hostSlug || folderName === hostSlug;
    }) ?? null
  );
}

export function resolveGlasswingSelectedProject<T extends GlasswingProjectCandidate>(
  projects: readonly T[],
  input: {
    readonly hostProject: GlasswingHostProjectIdentity | null;
    readonly activeProjectId: string | null;
  },
): T | null {
  if (input.hostProject) {
    return resolveGlasswingHostProject(projects, input.hostProject);
  }
  if (!input.activeProjectId) return null;
  return projects.find((project) => project.id === input.activeProjectId) ?? null;
}

export function toGlasswingProjectOptions<T extends GlasswingProjectCandidate>(
  projects: readonly T[],
): GlasswingProjectCandidate[] {
  return projects.map(({ id, name, cwd }) => ({ id, name, cwd }));
}

export function resolveGlasswingProjectThreadProjection<
  TProject extends GlasswingProjectCandidate,
  TThread extends { readonly projectId: string },
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  hostProject: GlasswingHostProjectIdentity,
): { readonly project: TProject | null; readonly threads: TThread[] } {
  const project = resolveGlasswingHostProject(projects, hostProject);
  if (!project) return { project: null, threads: [] };

  return {
    project,
    threads: threads.filter((thread) => thread.projectId === project.id),
  };
}
