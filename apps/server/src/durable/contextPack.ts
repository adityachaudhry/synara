/**
 * Glasswing context packs for company chats.
 *
 * Glasswing assembles the memory that applies to a conversation (firm, the requesting person, the
 * deal) at the company-data head commit and returns it as one prompt. The controller asks for a
 * pack at the first turn of a session and again once the cached pack is older than 30 minutes, and
 * shows its prompt as a system section. A pack is context, not a dependency: on any failure the
 * turn runs without one and the failure is logged.
 */
import type { OrchestrationMessageAuthor } from "@synara/contracts";

import { artifactApiClient } from "../providerWorker/artifactPublisher.ts";

const MAX_AGE_MS = 30 * 60_000;
/** A failing Glasswing is asked again after this long, not on every turn. */
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Packs are capped well below this by Glasswing; the bound only protects the prompt. */
const MAX_PROMPT_CHARS = 80_000;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;

export interface ContextPack {
  readonly packId: string;
  readonly commitSha: string | undefined;
  readonly prompt: string;
}

export interface ContextPackRequest {
  readonly companyId: string;
  readonly requesterEmail: string | null;
}

/** The authenticated author's email (Glasswing sends it as the author label). */
export const requesterEmailOf = (author: OrchestrationMessageAuthor | undefined): string | null =>
  [author?.label, author?.subject]
    .map((value) => value?.trim())
    .find((value) => value && EMAIL.test(value))
    ?.toLowerCase() ?? null;

const describe = (cause: unknown) =>
  (cause instanceof Error ? cause.message : String(cause)).slice(0, 300);

export class ContextPackCache {
  readonly #entries = new Map<
    string,
    { readonly key: string; readonly fetchedAt: number; readonly pack: ContextPack }
  >();
  readonly #failures = new Map<string, { readonly key: string; readonly at: number }>();
  readonly #inflight = new Map<string, Promise<void>>();

  /** A new session: its first turn fetches a fresh pack. */
  reset(threadId: string) {
    this.#entries.delete(threadId);
    this.#failures.delete(threadId);
  }

  prompt(threadId: string): string | undefined {
    const prompt = this.#entries.get(threadId)?.pack.prompt;
    return prompt ? prompt : undefined;
  }

  packId(threadId: string): string | undefined {
    return this.#entries.get(threadId)?.pack.packId;
  }

  /** Fetches when the thread has no pack for this company and requester, or it is older than 30 minutes. Never throws. */
  refresh(threadId: string, request: ContextPackRequest): Promise<void> {
    const key = `${request.companyId}|${request.requesterEmail ?? ""}`;
    const entry = this.#entries.get(threadId);
    if (entry?.key === key && Date.now() - entry.fetchedAt < MAX_AGE_MS) return Promise.resolve();
    const failed = this.#failures.get(threadId);
    if (failed?.key === key && Date.now() - failed.at < RETRY_AFTER_FAILURE_MS)
      return Promise.resolve();
    const running = this.#inflight.get(threadId);
    if (running) return running;
    const task = this.#fetch(threadId, key, request).finally(() => this.#inflight.delete(threadId));
    this.#inflight.set(threadId, task);
    return task;
  }

  async #fetch(threadId: string, key: string, request: ContextPackRequest) {
    try {
      const api = artifactApiClient();
      if (!api) return;
      const response = await api<{ pack_id?: unknown; commit_sha?: unknown; prompt?: unknown }>(
        "/internal/context-packs",
        { company_id: request.companyId, requester_email: request.requesterEmail, agent: "chat" },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (typeof response.pack_id !== "string" || typeof response.prompt !== "string") {
        throw new Error("The context pack response has no pack_id or prompt.");
      }
      const prompt = response.prompt.trim();
      const pack: ContextPack = {
        packId: response.pack_id,
        commitSha: typeof response.commit_sha === "string" ? response.commit_sha : undefined,
        prompt: prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt,
      };
      this.#entries.set(threadId, { key, fetchedAt: Date.now(), pack });
      this.#failures.delete(threadId);
      console.info(
        JSON.stringify({
          event: "durable.context-pack.loaded",
          threadId,
          packId: pack.packId,
          commitSha: pack.commitSha ?? null,
          chars: prompt.length,
          truncated: prompt.length > MAX_PROMPT_CHARS,
        }),
      );
    } catch (cause) {
      this.#failures.set(threadId, { key, at: Date.now() });
      // A stale pack for the same company and requester still beats none; another requester's never shows.
      if (this.#entries.get(threadId)?.key !== key) this.#entries.delete(threadId);
      console.warn(
        JSON.stringify({
          event: "durable.context-pack.unavailable",
          threadId,
          companyId: request.companyId,
          message: describe(cause),
        }),
      );
    }
  }
}
