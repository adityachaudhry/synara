/**
 * Internal route for Glasswing notes: a message from Glasswing posted as its own thread
 * in a company's workspace feed (e.g. what the partner meeting said about the company).
 * Same private-network + service-token guard as the diligence routes. Idempotent on noteId.
 */
import { CommandId, ProjectId, ThreadId } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";

import { readMcpJsonBody } from "../agentGateway/httpRoute.ts";
import { ExternalProjectResolver } from "../externalProjectResolver.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { DiligenceRequest } from "./diligence.ts";
import { authorized, json } from "./diligenceRoute.ts";

interface NoteRequest {
  readonly noteId: string;
  readonly company: { readonly id: string; readonly slug: string; readonly name: string };
  readonly repository: DiligenceRequest["repository"];
  readonly title: string;
  /** The feed starter (a short line); `text` then follows as Glasswing's reply. */
  readonly starter?: string;
  readonly text: string;
  readonly createdAt?: string;
}

const NOTE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,120}$/u;

export const noteThreadId = (noteId: string) => `glasswing-note-${noteId}`;

const postNote = (note: NoteRequest) => Effect.gen(function* () {
  const threadId = ThreadId.makeUnsafe(noteThreadId(note.noteId));
  const snapshots = yield* ProjectionSnapshotQuery;
  if (Option.isSome(yield* snapshots.getThreadShellById(threadId))) return threadId;
  const resolver = yield* ExternalProjectResolver;
  const projectId: ProjectId = yield* resolver.resolveExternalProject({
    externalKey: `glasswing-company:${note.company.id}`,
    name: note.company.name,
    repositoryBinding: note.repository,
  });
  const engine = yield* OrchestrationEngineService;
  const at = note.createdAt && !Number.isNaN(Date.parse(note.createdAt)) ? note.createdAt : new Date().toISOString();
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(`note-thread-${note.noteId}`),
    threadId,
    projectId,
    title: note.title,
    modelSelection: { provider: "pi", model: "anthropic/claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    createdAt: at,
  } as never);
  // The feed lists a thread by its first user-role message (as with a diligence run's
  // request), so the starter is imported as one, authored by Glasswing; the note's content
  // follows as Glasswing's reply. Importing starts no agent turn; a person's reply continues
  // the thread with the company's agent.
  const author = { subject: "glasswing:note", label: "Glasswing" };
  const starter = note.starter?.trim();
  const later = new Date(Date.parse(at) + 1000).toISOString();
  yield* engine.dispatch({
    type: "thread.messages.import",
    commandId: CommandId.makeUnsafe(`note-message-${note.noteId}`),
    threadId,
    messages: starter
      ? [
          { messageId: `note-${note.noteId}`, role: "user", text: starter, author, createdAt: at, updatedAt: at },
          { messageId: `note-${note.noteId}-body`, role: "assistant", text: note.text, author, createdAt: later, updatedAt: later },
        ]
      : [{ messageId: `note-${note.noteId}`, role: "user", text: note.text, author, createdAt: at, updatedAt: at }],
    createdAt: at,
  } as never);
  return threadId;
});

const notesRoute = HttpRouter.add("POST", "/internal/notes", Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!authorized(request.headers.authorization, request.headers.host)) return json({ error: "unauthorized" }, 401);
  const body = yield* readMcpJsonBody(request, 256 * 1024);
  if (body.kind !== "ok") return json({ error: body.kind === "too-large" ? "note too large" : "invalid JSON" }, body.kind === "too-large" ? 413 : 400);
  const note = body.body as NoteRequest;
  if (!note?.noteId || !NOTE_ID.test(note.noteId) || !note.company?.id || !note.repository?.path || !note.title?.trim() || !note.text?.trim()) {
    return json({ error: "noteId, company, repository, title and text are required" }, 400);
  }
  return yield* postNote(note).pipe(
    Effect.map((threadId) => json({ threadId }, 201)),
    Effect.catch((cause) => Effect.sync(() => {
      console.warn(`[notes] ${JSON.stringify({ event: "note.post-failed", noteId: note.noteId, message: String(cause) })}`);
      return json({ error: String(cause) }, 500);
    })),
  );
}));

/** The thread's messages, so Glasswing can fold the team's replies (corrections) into its record. */
const messagesRoute = HttpRouter.add("GET", "/internal/notes/:noteId/messages", Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!authorized(request.headers.authorization, request.headers.host)) return json({ error: "unauthorized" }, 401);
  const noteId = new URL(request.url, "http://local").pathname.match(/^\/internal\/notes\/([^/]+)\/messages$/u)?.[1];
  if (!noteId || !NOTE_ID.test(noteId)) return json({ error: "unknown note" }, 404);
  const snapshots = yield* ProjectionSnapshotQuery;
  const thread = yield* snapshots.getThreadDetailForExportById(ThreadId.makeUnsafe(noteThreadId(noteId))).pipe(
    Effect.catch(() => Effect.succeed(Option.none())),
  );
  if (Option.isNone(thread)) return json({ error: "unknown note" }, 404);
  return json({
    threadId: thread.value.id,
    messages: thread.value.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      author: message.author ?? null,
      createdAt: message.createdAt,
    })),
  });
}));

/** Archive a note thread Glasswing has superseded (re-posted in a newer form). Idempotent. */
const archiveRoute = HttpRouter.add("POST", "/internal/notes/:noteId/archive", Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!authorized(request.headers.authorization, request.headers.host)) return json({ error: "unauthorized" }, 401);
  const noteId = new URL(request.url, "http://local").pathname.match(/^\/internal\/notes\/([^/]+)\/archive$/u)?.[1];
  if (!noteId || !NOTE_ID.test(noteId)) return json({ error: "invalid note id" }, 400);
  const threadId = ThreadId.makeUnsafe(noteThreadId(noteId));
  const snapshots = yield* ProjectionSnapshotQuery;
  const shell = yield* snapshots.getThreadShellById(threadId);
  if (Option.isNone(shell)) return json({ archived: false });
  if (shell.value.archivedAt) return json({ archived: true });
  const engine = yield* OrchestrationEngineService;
  return yield* engine.dispatch({
    type: "thread.archive",
    commandId: CommandId.makeUnsafe(`note-archive-${noteId}`),
    threadId,
  } as never).pipe(
    Effect.map(() => json({ archived: true })),
    Effect.catch((cause) => Effect.succeed(json({ error: String(cause) }, 500))),
  );
}));

export const notesRouteLayer = Layer.mergeAll(notesRoute, messagesRoute, archiveRoute);
