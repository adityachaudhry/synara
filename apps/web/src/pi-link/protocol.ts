/**
 * Pi Link wire protocol: one WebSocket per browser between the Pi Link worker and this gateway.
 * JSON text frames. Pi's state travels as Chord delta ops, encoded per subscription.
 *
 * The browser copy of this file is `apps/web/src/pi-link/protocol.ts` in the Synara UI package;
 * keep the two identical (the server accepts PROTOCOL and PROTOCOL - 1).
 */

export const PROTOCOL = 1;

/** Ops as `@earendil-works/chord/delta` encodes them (`WireOp[]`). */
export type WireOps = readonly unknown[];

export type Topic =
  /** One thread's live Pi view: its newest entries and its documents (pi.live, glasswing.thread, glasswing.run …). */
  | { readonly kind: "thread"; readonly threadId: string }
  /** One company's thread list (`glasswing.company-threads`). */
  | { readonly kind: "company"; readonly companyId: string; readonly slug?: string };

export type ClientMessage =
  | { readonly t: "hello"; readonly protocol: number; readonly build: string; readonly ticket: string }
  | { readonly t: "reauth"; readonly ticket: string }
  | { readonly t: "sub"; readonly sid: number; readonly topic: Topic }
  | { readonly t: "ack"; readonly sid: number; readonly n: number }
  | { readonly t: "unsub"; readonly sid: number }
  | {
      readonly t: "page";
      readonly rid: number;
      readonly threadId: string;
      readonly query: { readonly minEntryId?: number; readonly maxEntryId?: number; readonly order: "ascending" | "descending" };
      readonly limit: number;
      readonly cursor?: unknown;
    }
  | { readonly t: "cmd"; readonly rid: number; readonly kind: CommandKind; readonly args: Record<string, unknown> }
  | { readonly t: "ping" };

export type ServerMessage =
  | {
      readonly t: "welcome";
      readonly protocol: number;
      readonly server: { readonly commit: string };
      readonly user: { readonly subject: string; readonly label?: string };
      readonly limits: { readonly maxUnacked: number; readonly pageLimit: number };
    }
  /** `n` counts frames per subscription from 1; the first frame of a subscription is a root replace. */
  | { readonly t: "frame"; readonly sid: number; readonly n: number; readonly ops: WireOps }
  | { readonly t: "subError"; readonly sid: number; readonly error: WireError }
  | { readonly t: "pageResult"; readonly rid: number; readonly items: readonly unknown[]; readonly next?: unknown }
  | { readonly t: "done"; readonly rid: number; readonly result: unknown }
  | { readonly t: "fail"; readonly rid: number; readonly error: WireError }
  | { readonly t: "pong" }
  | { readonly t: "bye"; readonly reason: "unauthorized" | "expired" | "protocol" | "shutdown" };

export type WireError = { readonly code: string; readonly message: string };

export type CommandKind =
  | "thread.create"
  | "thread.update"
  | "thread.delete"
  | "send"
  | "stop"
  | "message.write"
  | "mark.add"
  | "mark.remove"
  | "mark.update"
  | "run.stop"
  | "workspace.prepare"
  | "models.list";

/** Limits the gateway holds to (Pi Link design, budgets). */
export const LIMITS = {
  maxUnacked: 2,
  pageLimit: 200,
  /** Entries a thread view holds: newest `min`, trimmed back to `min` past `max`. */
  viewWindow: { min: 30, max: 60 },
  /** Frames per hub at most this often. */
  frameIntervalMs: 100,
  hubIdleCloseMs: 60_000,
  maxHubs: 300,
  pingIntervalMs: 15_000,
  silenceCloseMs: 30_000,
  /** A socket not re-authenticated within this long is closed. */
  ticketGraceMs: 10 * 60_000,
} as const;
