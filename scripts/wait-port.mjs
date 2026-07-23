/**
 * wait-port — block until a TCP port accepts connections, then exit 0 (or 1 on timeout).
 *
 * Used by the `dev:jazz` orchestration so the backend only starts deploying its schema
 * once the standalone Jazz sync server is actually listening (concurrently starts every
 * process at once, so we gate the backend here).
 *
 *   bun scripts/wait-port.mjs <port> [host]     # WAIT_TIMEOUT ms overrides the default
 */
import net from "node:net";

const port = Number(process.argv[2]);
const host = process.argv[3] ?? "127.0.0.1";
const timeoutMs = Number(process.env.WAIT_TIMEOUT ?? 60_000);
const start = Date.now();

if (!port) {
  console.error("usage: bun scripts/wait-port.mjs <port> [host]");
  process.exit(2);
}

function attempt() {
  const socket = net.connect(port, host);
  socket.once("connect", () => {
    socket.destroy();
    process.exit(0);
  });
  socket.once("error", () => {
    socket.destroy();
    if (Date.now() - start > timeoutMs) {
      console.error(`wait-port: timed out waiting for ${host}:${port}`);
      process.exit(1);
    }
    setTimeout(attempt, 300);
  });
}

attempt();
