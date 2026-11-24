// FILE: pi-link/messages.ts
// Purpose: Messages between a tab (PiLinkTransport) and the Pi Link worker.
// Layer: Pi Link shared types.

export interface PiLinkProject {
  /** The Glasswing company id; Synara's project id in this mode. */
  readonly companyId: string;
  readonly slug: string;
  readonly name: string;
  readonly repository?: { readonly origin: string; readonly owner: string; readonly repository: string; readonly ref: string };
}

export interface TabConfig {
  /** wss://…/ws on the agent service. */
  readonly wsUrl: string;
  /** Same-origin URL that mints a ticket for the signed-in person (POST). */
  readonly ticketUrl: string;
  readonly project: PiLinkProject;
}

export type TabMessage =
  | { readonly t: "init"; readonly config: TabConfig; readonly visible: boolean }
  | { readonly t: "visible"; readonly visible: boolean }
  | { readonly t: "req"; readonly rid: number; readonly method: string; readonly params: unknown }
  | { readonly t: "ack"; readonly n: number }
  | { readonly t: "beat" }
  | { readonly t: "ticket"; readonly rid: number; readonly ticket?: string; readonly status?: number }
  | { readonly t: "bye" };

export type PortMessage =
  | { readonly t: "batch"; readonly n: number; readonly items: ReadonlyArray<{ readonly channel: string; readonly data: unknown }> }
  | { readonly t: "res"; readonly rid: number; readonly ok: boolean; readonly value?: unknown; readonly error?: { readonly message: string; readonly code: string } }
  | { readonly t: "state"; readonly state: "connecting" | "open" | "closed" }
  /** The worker asks a tab for a ticket: the tab's fetch carries the host's session refresh. */
  | { readonly t: "needTicket"; readonly rid: number };
