import { Buffer } from "node:buffer";

import type {
  GiteaCompanyCatalogSnapshot,
  GiteaCompanyProjectDescriptor,
  ProjectRepositoryBinding,
} from "@synara/contracts";
import { Effect, Layer } from "effect";

import { GiteaCompanyCatalogError } from "../Errors";
import {
  GiteaCompanyCatalog,
  type GiteaCompanyCatalogShape,
} from "../Services/GiteaCompanyCatalog";
import type { GiteaCompanyCatalogConfig } from "../config";

interface GiteaContentsEntry {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly path?: unknown;
}

interface GiteaFileResponse {
  readonly encoding?: unknown;
  readonly content?: unknown;
}

interface CompanyMetadata {
  readonly company_id?: unknown;
  readonly company_name?: unknown;
  readonly company_slug?: unknown;
}

export interface MakeGiteaCompanyCatalogOptions {
  readonly config: GiteaCompanyCatalogConfig;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
  readonly concurrency?: number;
}

function catalogError(operation: string, detail: string, cause?: unknown) {
  return new GiteaCompanyCatalogError({ operation, detail, ...(cause === undefined ? {} : { cause }) });
}

function isCompanySlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value)
  );
}

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maxLength;
}

function equalBinding(left: ProjectRepositoryBinding, right: ProjectRepositoryBinding): boolean {
  return (
    left.kind === right.kind &&
    left.origin === right.origin &&
    left.owner === right.owner &&
    left.repository === right.repository &&
    left.ref === right.ref &&
    left.path === right.path
  );
}

function humanizeCompanySlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0]?.toLocaleUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function httpStatusFromCatalogError(error: GiteaCompanyCatalogError): number | undefined {
  const cause = error.cause;
  return cause !== null && typeof cause === "object" && "status" in cause
    ? ((cause as { readonly status?: unknown }).status as number | undefined)
    : undefined;
}

async function mapBounded<T, R>(
  values: ReadonlyArray<T>,
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await map(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export function makeGiteaCompanyCatalog(
  options: MakeGiteaCompanyCatalogOptions,
): GiteaCompanyCatalogShape {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? 30_000;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 6, 16));
  let cached: { readonly expiresAt: number; readonly snapshot: GiteaCompanyCatalogSnapshot } | undefined;
  let inFlight: Promise<GiteaCompanyCatalogSnapshot> | undefined;

  const disabledSnapshot = (): GiteaCompanyCatalogSnapshot => ({
    available: false,
    projects: [],
    diagnostics: ["Gitea company catalog is not configured."],
    refreshedAt: new Date(now()).toISOString(),
  });

  const requestJson = async (url: string): Promise<unknown> => {
    if (!options.config.enabled) throw catalogError("list", "Gitea company catalog is not configured.");
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: {
          accept: "application/json",
          authorization: `token ${options.config.readToken}`,
        },
      });
    } catch (cause) {
      throw catalogError(
        "fetch",
        "Gitea catalog request could not reach the configured server.",
        cause,
      );
    }
    if (!response.ok) {
      throw catalogError(
        "fetch",
        `Gitea catalog request failed with HTTP ${response.status}.`,
        { status: response.status },
      );
    }
    return response.json();
  };

  const load = async (): Promise<GiteaCompanyCatalogSnapshot> => {
    const config = options.config;
    if (!config.enabled) return disabledSnapshot();
    const repoBase = `${config.origin}/api/v1/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}/contents`;
    const refQuery = `?ref=${encodeURIComponent(config.ref)}`;
    const listed = await requestJson(`${repoBase}/${encodeURIComponent(config.companiesRoot)}${refQuery}`);
    if (!Array.isArray(listed)) {
      throw catalogError("list", "Gitea companies root returned an invalid directory listing.");
    }
    const directories = listed.filter(
      (entry): entry is GiteaContentsEntry & { readonly name: string; readonly path: string } => {
        const candidate = entry as GiteaContentsEntry;
        return candidate.type === "dir" && isCompanySlug(candidate.name) && typeof candidate.path === "string";
      },
    );
    const loaded = await mapBounded(directories, concurrency, async (directory) => {
      const expectedPath = `${config.companiesRoot}/${directory.name}`;
      if (directory.path !== expectedPath) {
        return { diagnostic: `Skipped ${expectedPath}: invalid directory path.` } as const;
      }
      const binding: ProjectRepositoryBinding = {
        kind: "gitea-subdirectory",
        origin: config.origin,
        owner: config.owner,
        repository: config.repository,
        ref: config.ref,
        path: expectedPath,
      };
      try {
        const raw = (await requestJson(
          `${repoBase}/${encodeURIComponent(config.companiesRoot)}/${encodeURIComponent(directory.name)}/company.json${refQuery}`,
        )) as GiteaFileResponse;
        if (raw.encoding !== "base64" || typeof raw.content !== "string") throw new Error("invalid content envelope");
        const metadata = JSON.parse(Buffer.from(raw.content.replaceAll("\n", ""), "base64").toString("utf8")) as CompanyMetadata;
        if (
          !isNonEmptyBoundedString(metadata.company_id, 256) ||
          !isNonEmptyBoundedString(metadata.company_name, 256) ||
          metadata.company_slug !== directory.name
        ) {
          throw new Error("invalid metadata");
        }
        const descriptor: GiteaCompanyProjectDescriptor = {
          companyId: metadata.company_id,
          companyName: metadata.company_name,
          companySlug: directory.name,
          workspaceRoot: `${config.projectRoot}/${directory.name}`,
          binding,
        };
        return { descriptor } as const;
      } catch (cause) {
        if (
          cause instanceof GiteaCompanyCatalogError &&
          httpStatusFromCatalogError(cause) !== 404
        ) {
          throw cause;
        }
        const descriptor: GiteaCompanyProjectDescriptor = {
          companyId: `company:${directory.name}`,
          companyName: humanizeCompanySlug(directory.name),
          companySlug: directory.name,
          workspaceRoot: `${config.projectRoot}/${directory.name}`,
          binding,
        };
        return {
          descriptor,
          diagnostic: `Using directory fallback for ${expectedPath}: invalid company.json metadata.`,
        } as const;
      }
    });
    const projects = loaded
      .flatMap((entry) => ("descriptor" in entry ? [entry.descriptor] : []))
      .toSorted((left, right) => left.companyName.localeCompare(right.companyName));
    const diagnostics = loaded.flatMap((entry) => ("diagnostic" in entry ? [entry.diagnostic] : []));
    return {
      available: true,
      projects,
      diagnostics,
      refreshedAt: new Date(now()).toISOString(),
    };
  };

  const list: GiteaCompanyCatalogShape["list"] = () =>
    Effect.tryPromise({
      try: async () => {
        const currentNow = now();
        if (cached && cached.expiresAt > currentNow) return cached.snapshot;
        inFlight ??= load().finally(() => {
          inFlight = undefined;
        });
        const snapshot = await inFlight;
        cached = { expiresAt: currentNow + cacheTtlMs, snapshot };
        return snapshot;
      },
      catch: (cause) =>
        cause instanceof GiteaCompanyCatalogError
          ? cause
          : catalogError("list", "Failed to refresh the Gitea company catalog.", cause),
    });

  const resolveBinding: GiteaCompanyCatalogShape["resolveBinding"] = (binding) =>
    Effect.gen(function* () {
      const snapshot = yield* list();
      const canonical = snapshot.projects.find((project) => equalBinding(project.binding, binding));
      if (!canonical) {
        return yield* catalogError(
          "validateBinding",
          "The requested Gitea project binding is not present in the configured company catalog.",
        );
      }
      return canonical;
    });

  const validateBinding: GiteaCompanyCatalogShape["validateBinding"] = (binding) =>
    resolveBinding(binding).pipe(Effect.map((descriptor) => descriptor.binding));

  return { list, validateBinding, resolveBinding };
}

export function makeGiteaCompanyCatalogLive(options: MakeGiteaCompanyCatalogOptions) {
  return Layer.succeed(GiteaCompanyCatalog, makeGiteaCompanyCatalog(options));
}
