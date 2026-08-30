/**
 * Private-use WebSocket close code for a rejected provider-worker protocol frame.
 *
 * The WHATWG client API only permits applications to send code 1000 or codes in
 * the 3000-4999 range. Node's global WebSocket therefore rejects RFC code 1008
 * when it is passed to `WebSocket.close()` by application code.
 */
export const PROVIDER_WORKER_PROTOCOL_REJECTED_CLOSE_CODE = 4400;
