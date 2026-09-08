import { Effect } from "effect";
import Mime from "@effect/platform-node/Mime";
import type { ProviderPersistenceCandidate } from "../providerPersistence.ts";
import type { ProviderWorkerRuntimeBinding } from "./runtimeBinding.ts";
import type { ProviderWorkerBrokerShape } from "./Services/ProviderWorkerBroker.ts";
import { isTrustedPrivateWorkerUrl } from "./privateNetwork.ts";

interface ArtifactRecord {
  artifact_id: string;
  path: string;
  sha256: string;
  size_bytes: number;
  published_commit_sha?: string | null;
}
interface UploadGrant {
  artifact_id: string;
  upload_url: string;
  headers: Record<string, string>;
}

export function artifactApiClient() {
  const origin = process.env.SYNARA_ARTIFACT_API_URL?.trim();
  const token = process.env.GLASSWING_ARTIFACT_SERVICE_TOKEN?.trim();
  if (!origin && !token) return undefined;
  if (!origin || !token)
    throw new Error("Artifact API URL and service token must both be configured.");
  const url = new URL(origin);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
          isTrustedPrivateWorkerUrl(url, process.env))
      ))
  ) {
    throw new Error(
      "Artifact API origin must be HTTPS, loopback, or an explicit Railway private service.",
    );
  }
  return async <T>(route: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${url.origin}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Artifact API failed with HTTP ${response.status}.`);
    return response.json() as Promise<T>;
  };
}

/** The coordinator sends grants and small metadata; file bytes never pass through it. */
export const publishOutboxArtifacts = Effect.fn(function* (input: {
  readonly binding: ProviderWorkerRuntimeBinding;
  readonly entries: ReadonlyArray<ProviderPersistenceCandidate>;
  readonly broker: ProviderWorkerBrokerShape;
  readonly turnId?: string;
}) {
  const api = yield* Effect.try({ try: artifactApiClient, catch: (cause) => cause });
  const binding = input.binding;
  if (!api || !binding.threadId || !binding.repositoryCheckout) return undefined;
  const companyPath = binding.repositoryCheckout.binding.path;
  if (!/^companies\/[a-z0-9][a-z0-9-]*$/u.test(companyPath)) return undefined;
  const companySlug = companyPath.slice("companies/".length);
  const query = new URLSearchParams({ company_slug: companySlug, thread_id: binding.threadId });
  const existing = yield* Effect.tryPromise({
    try: () => api<{ artifacts: ArtifactRecord[] }>(`/internal/chat-artifacts?${query}`),
    catch: (cause) => cause,
  });
  const files = input.entries.filter(
    (entry) =>
      entry.source === "outbox" &&
      !existing.artifacts.some(
        (saved) => saved.path === entry.path && saved.sha256 === entry.sha256,
      ),
  );
  for (const file of files) {
    const grant = yield* Effect.tryPromise({
      try: () =>
        api<UploadGrant>("/internal/chat-artifacts/grants", {
          company_slug: companySlug,
          thread_id: binding.threadId,
          ...(input.turnId ? { turn_id: input.turnId } : {}),
          source_commit: binding.repositoryCheckout!.commit,
          path: file.path,
          sha256: file.sha256,
          size_bytes: file.sizeBytes,
          media_type: Mime.getType(file.path) ?? "application/octet-stream",
        }),
      catch: (cause) => cause,
    });
    yield* input.broker.request(binding.fence, "artifacts.upload", {
      files: [
        {
          path: file.path,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
          uploadUrl: grant.upload_url,
          headers: grant.headers,
        },
      ],
    });
    yield* Effect.tryPromise({
      try: () =>
        api<ArtifactRecord>(
          `/internal/chat-artifacts/${encodeURIComponent(grant.artifact_id)}/complete`,
          {},
        ),
      catch: (cause) => cause,
    });
  }
  if (files.length)
    yield* Effect.logInfo("provider artifacts uploaded directly", {
      threadId: binding.threadId,
      count: files.length,
      bytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    });
  return input.entries.filter(
    (entry) =>
      entry.source !== "outbox" ||
      !existing.artifacts.some(
        (saved) =>
          saved.path === entry.path && saved.sha256 === entry.sha256 && saved.published_commit_sha,
      ),
  );
});
