#!/usr/bin/env bun
// Quick interactive test tool to trigger actions on the running Octane MCP server

const port = process.env.OCTANE_PORT || 3002;

async function checkStatus() {
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    console.log("Octane MCP Bridge Status:");
    console.log("- Bridge Server: ONLINE (Port " + port + ")");
    console.log("- Studio Connected: " + (health.connected ? "YES! :D" : "NO (Waiting for Studio plugin)"));
    if (health.lastHeartbeat) {
      console.log("- Last Heartbeat: " + new Date(health.lastHeartbeat).toLocaleTimeString());
    }
    return health.connected;
  } catch (err) {
    console.error("Could not reach Octane MCP Bridge:", err.message);
    return false;
  }
}

checkStatus();
