import type { NodeWS } from "@effect/platform-node/NodeSocket";

// The ws socket accepted for each upgraded request, so server-initiated endings
// (session expiry) can send a proper close frame. Interrupting the connection
// fiber instead makes the HTTP layer write a response onto the already-upgraded
// socket: browsers report "Invalid frame header" and close with 1006.
const socketsByRequest = new WeakMap<object, NodeWS.WebSocket>();

export function trackUpgradedWebSockets(server: NodeWS.WebSocketServer): void {
  const handleUpgrade = server.handleUpgrade.bind(server);
  server.handleUpgrade = ((request, socket, head, callback) =>
    handleUpgrade(request, socket, head, (ws, upgradedRequest) => {
      socketsByRequest.set(request, ws);
      callback(ws, upgradedRequest);
    })) as NodeWS.WebSocketServer["handleUpgrade"];
}

/** Starts a clean close of the request's WebSocket; false if it has none open. */
export function closeUpgradedWebSocket(request: unknown, code: number, reason: string): boolean {
  if (typeof request !== "object" || request === null) return false;
  const ws = socketsByRequest.get(request);
  if (!ws || ws.readyState !== ws.OPEN) return false;
  ws.close(code, reason);
  return true;
}
