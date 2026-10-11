#!/usr/bin/env node
import { OctaneMcpBridge } from "./server.js";

process.on("uncaughtException", (err) => {
  console.error("[Octane MCP Crash] uncaughtException:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Octane MCP Crash] unhandledRejection:", reason);
});

let port = 3002;
const rawPort = process.env.OCTANE_PORT || process.argv[2];
if (rawPort) {
  const parsed = parseInt(rawPort, 10);
  if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
    port = parsed;
  }
}

const bridge = new OctaneMcpBridge(port);

bridge.start().catch((err) => {
  console.error("[Octane MCP] Fatal server error:", err);
  process.exit(1);
});

