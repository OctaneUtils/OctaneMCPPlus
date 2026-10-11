#!/usr/bin/env bun
import { OctaneMcpBridge } from "./server.js";

const port = parseInt(process.env.OCTANE_PORT || process.argv[2] || "3002", 10);
const bridge = new OctaneMcpBridge(port);

bridge.start().catch((err) => {
  console.error("[Octane MCP] Fatal server error:", err);
  process.exit(1);
});
