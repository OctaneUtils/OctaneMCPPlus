import { describe, test, expect, afterAll } from "bun:test";
import { OctaneMcpBridge } from "../src/server.js";

describe("Octane MCP Bridge (Elysia)", () => {
  const TEST_PORT = 3004;
  const bridge = new OctaneMcpBridge(TEST_PORT);
  bridge.startElysiaServer();

  afterAll(() => {
    bridge.app.stop();
  });

  test("health check returns ok", async () => {
    const health = await fetch(`http://127.0.0.1:${TEST_PORT}/health`).then((r) => r.json());
    expect(health.ok).toBe(true);
    expect(health.version).toBe("1.0.0");
    expect(typeof health.connected).toBe("boolean");
  });

  test("status check returns ok", async () => {
    const status = await fetch(`http://127.0.0.1:${TEST_PORT}/status`).then((r) => r.json());
    expect(status.ok).toBe(true);
  });

  test("poll returns idle when queue is empty", async () => {
    const poll = await fetch(`http://127.0.0.1:${TEST_PORT}/poll`).then((r) => r.json());
    expect(poll.status).toBe("idle");
  });

  test("command delivery and execution response roundtrip", async () => {
    // 1. Enqueue command via bridge
    const commandPromise = bridge.sendCommand("read_script", { path: "ServerScriptService.Main" });

    // 2. Simulate plugin polling
    const pollResult = await fetch(`http://127.0.0.1:${TEST_PORT}/poll`).then((r) => r.json());
    expect(pollResult.status).toBe("command");
    expect(pollResult.command.action).toBe("read_script");

    const cmdId = pollResult.command.id;

    // 3. Simulate plugin responding
    const respondRes = await fetch(`http://127.0.0.1:${TEST_PORT}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: cmdId,
        success: true,
        result: {
          name: "Main",
          className: "Script",
          path: "ServerScriptService.Main",
          source: "print('Hello Octane!')",
        },
        logs: ["Loaded script successfully"],
      }),
    }).then((r) => r.json());

    expect(respondRes.status).toBe("ok");

    // 4. Verify command promise resolved
    const cmdResult = await commandPromise;
    expect(cmdResult.result.name).toBe("Main");
    expect(cmdResult.result.source).toBe("print('Hello Octane!')");
    expect(cmdResult.logs[0]).toBe("Loaded script successfully");
  });
});
