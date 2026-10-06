import {
  PROVIDER_WORKER_PROTOCOL_VERSION,
  PROVIDER_WORKER_MAX_MESSAGE_BYTES,
  type ProviderRuntimeEvent,
  type ProviderWorkerEvent,
} from "@synara/contracts";

import { ProviderWorkerTransportError } from "./Errors";
import type { ProviderWorkerFence } from "./fence";
import { compactProviderRuntimeEventForIngress } from "../provider/providerRuntimeEventIngress";

const frameBytes = (frame: ProviderWorkerEvent) => Buffer.byteLength(JSON.stringify(frame), "utf8");
const preview = (text: string) => text.length > 8_192
  ? text.slice(0, 8_192) + "\n[Activity preview shortened; full output remains in the agent session.]"
  : text;

function boundActivityFrame(frame: ProviderWorkerEvent): ProviderWorkerEvent {
  const originalBytes = frameBytes(frame);
  if (originalBytes <= PROVIDER_WORKER_MAX_MESSAGE_BYTES) return frame;
  // Diagnostic SDK payloads and repeated tool fields are presentation copies.
  // Compact before retention: replaying an oversized frame otherwise closes
  // every reconnect with 1009 and strands the turn, even after it completes.
  let bounded = { ...frame, event: compactProviderRuntimeEventForIngress(
    frame.event, PROVIDER_WORKER_MAX_MESSAGE_BYTES - 4_096,
  ).event };
  const event = bounded.event;
  if (frameBytes(bounded) > PROVIDER_WORKER_MAX_MESSAGE_BYTES &&
      (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed")) {
    const data = event.payload.data;
    const record = data !== null && typeof data === "object" ? data as Record<string, unknown> : {};
    const metadata = Object.fromEntries(["toolCallId", "callId", "toolName", "name", "kind", "path", "filePath", "command", "exitCode", "isError"]
      .filter((key) => typeof record[key] === "string" || typeof record[key] === "number" || typeof record[key] === "boolean")
      .map((key) => [key, typeof record[key] === "string" ? preview(record[key]) : record[key]]));
    const detail = preview(event.payload.detail ?? "[Large tool activity; full output remains in the agent session.]");
    bounded = { ...bounded, event: { ...event, payload: {
      ...event.payload,
      ...(event.payload.title ? { title: preview(event.payload.title) } : {}),
      detail, data: { ...metadata, previewTruncated: true, originalBytes, rawOutput: { stdout: detail } },
    } } };
  }
  const bytes = frameBytes(bounded);
  if (bytes > PROVIDER_WORKER_MAX_MESSAGE_BYTES) throw new ProviderWorkerTransportError({
    operation: "event.outbox", detail: `Provider event exceeds the delivery limit (${bytes} bytes; ${frame.event.type}).`,
  });
  console.warn("provider worker activity compacted", {
    threadId: frame.event.threadId, eventId: frame.event.eventId, type: frame.event.type,
    originalBytes, deliveredBytes: bytes,
  });
  return bounded;
}

export interface ProviderWorkerOutbox {
  readonly push: (event: ProviderRuntimeEvent) => ProviderWorkerEvent;
  readonly acknowledge: (sequence: number) => void;
  readonly pending: () => ReadonlyArray<ProviderWorkerEvent>;
  readonly lastAcknowledgedSequence: () => number;
}

export function makeProviderWorkerOutbox(
  fence: ProviderWorkerFence,
  capacity = 2_048,
): ProviderWorkerOutbox {
  const frames = new Map<number, ProviderWorkerEvent>();
  let nextSequence = 1;
  let acknowledgedSequence = 0;

  const push = (event: ProviderRuntimeEvent) => {
    if (frames.size >= capacity) {
      throw new ProviderWorkerTransportError({
        operation: "event.outbox",
        detail: "Provider worker event outbox reached its lossless capacity.",
      });
    }
    const frame = boundActivityFrame({
      protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
      ...fence,
      type: "event",
      sequence: nextSequence,
      event,
    });
    frames.set(nextSequence, frame);
    nextSequence += 1;
    return frame;
  };

  const acknowledge = (sequence: number) => {
    if (sequence <= acknowledgedSequence) return;
    if (sequence >= nextSequence) {
      throw new ProviderWorkerTransportError({
        operation: "event.acknowledge",
        detail: `Control plane acknowledged future worker event sequence ${String(sequence)}.`,
      });
    }
    acknowledgedSequence = sequence;
    for (const retainedSequence of frames.keys()) {
      if (retainedSequence <= sequence) frames.delete(retainedSequence);
    }
  };

  return {
    push,
    acknowledge,
    pending: () => Array.from(frames.values()),
    lastAcknowledgedSequence: () => acknowledgedSequence,
  };
}
