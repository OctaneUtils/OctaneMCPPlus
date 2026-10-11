import { Elysia } from "elysia";
import { node } from "@elysiajs/node";
import { mcp } from "elysia-mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export class OctaneMcpBridge {
  constructor(port = 3002) {
    let safePort = 3002;
    if (typeof port === "number" && !Number.isNaN(port) && port > 0 && port < 65536) {
      safePort = port;
    } else if (typeof port === "string") {
      const parsed = parseInt(port, 10);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
        safePort = parsed;
      }
    }
    this.port = safePort;
    this.pendingCommands = new Map(); // id -> { resolve, reject, timer, action }
    this.commandQueue = []; // array of { id, action, params }
    this.lastStudioHeartbeat = 0;
    this.app = null;

    // Stdio MCP Server (for CLI & spawned processes)
    this.stdioMcp = new McpServer({
      name: "octanemcpplus",
      version: "1.0.0",
    });

    this.setupMcpTools(this.stdioMcp);
  }

  isStudioConnected() {
    return Date.now() - this.lastStudioHeartbeat < 15000;
  }

  // Enqueue a command and wait for response from Octane Studio plugin
  sendCommand(action, params = {}, timeoutMs = 30000) {
    const id = `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const cmd = { id, action, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(
          new Error(
            `Command '${action}' timed out after ${timeoutMs}ms. Is Octane Studio running and plugin connected?`
          )
        );
      }, timeoutMs);

      this.pendingCommands.set(id, { resolve, reject, timer, action });
      console.error(`[Bridge] Queuing command for next Studio poll: ${cmd.action} (${cmd.id})`);
      this.commandQueue.push(cmd);
    });
  }

  // Start Elysia web server with elysia-mcp plugin + Octane bridge routes
  startElysiaServer() {
    const elysiaOptions = typeof Bun === "undefined" ? { adapter: node() } : {};
    this.app = new Elysia(elysiaOptions)
      .onRequest(({ set }) => {
        set.headers["Access-Control-Allow-Origin"] = "*";
        set.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
        set.headers["Access-Control-Allow-Headers"] = "Content-Type, Accept";
      })
      // elysia-mcp: Streamable HTTP MCP transport mounted at /mcp
      .use(
        mcp({
          serverInfo: {
            name: "octanemcpplus",
            version: "1.0.0",
          },
          capabilities: {
            tools: {},
          },
          setupServer: async (httpMcpServer) => {
            this.setupMcpTools(httpMcpServer);
          },
        })
      )
      // Health / Status
      .get("/health", () => ({
        ok: true,
        version: "1.0.0",
        connected: this.isStudioConnected(),
        lastHeartbeat: this.lastStudioHeartbeat,
        queuedCommands: this.commandQueue.length,
        pendingAwaits: this.pendingCommands.size,
      }))
      .get("/status", () => ({
        ok: true,
        version: "1.0.0",
        connected: this.isStudioConnected(),
        lastHeartbeat: this.lastStudioHeartbeat,
        queuedCommands: this.commandQueue.length,
        pendingAwaits: this.pendingCommands.size,
      }))
      // Poll endpoint for Octane Studio plugin (fast short-poll)
      .get("/poll", () => {
        this.lastStudioHeartbeat = Date.now();

        // If a command is queued, deliver it immediately
        if (this.commandQueue.length > 0) {
          const cmd = this.commandQueue.shift();
          console.error(`[Bridge /poll] Delivering queued command to Studio: ${cmd.action} (${cmd.id})`);
          return { status: "command", command: cmd };
        }

        // Return idle immediately (prevents cURL socket timeouts in Roblox)
        return { status: "idle" };
      })
      // Response endpoint where Octane Studio posts execution results
      .post("/respond", ({ body }) => {
        this.lastStudioHeartbeat = Date.now();
        const { id, success, result, error, logs } = body || {};
        console.error(`[Bridge /respond] Received response for ${id}: success=${success}`);
        const pending = this.pendingCommands.get(id);

        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCommands.delete(id);
          if (success) {
            pending.resolve({ result, logs });
          } else {
            pending.reject(new Error(error || "Unknown execution error in Octane Studio"));
          }
        }

        return { status: "ok" };
      })
      // Direct command execution endpoint (for testing/automation scripts)
      .post("/command", async ({ body, set }) => {
        try {
          const { action, params, timeoutMs } = body || {};
          return await this.sendCommand(action, params, timeoutMs);
        } catch (err) {
          set.status = 500;
          return { error: err.message };
        }
      });

    try {
      this.app.listen({ port: this.port }, ({ hostname, port }) => {
        console.error(`[OctaneMCPPlus (Elysia + elysia-mcp)] Listening on http://${hostname || "localhost"}:${port}`);
        console.error(`  - MCP HTTP Streamable endpoint: http://${hostname || "localhost"}:${port}/mcp`);
        console.error(`  - Studio Bridge poll endpoint:   http://${hostname || "localhost"}:${port}/poll`);
      });
    } catch (err) {
      console.error(
        `[OctaneMCPPlus] Notice: HTTP server could not bind to port ${this.port} (${err.message}). Stdio MCP server remains active.`
      );
    }
  }

  // Register all Model Context Protocol tools on an McpServer instance
  setupMcpTools(targetMcp) {
    // 1. Check Studio Connection Status
    targetMcp.tool(
      "get_status",
      "Check if Octane Studio is currently running and the MCP plugin is connected.",
      {},
      async () => {
        const connected = this.isStudioConnected();
        const info = {
          connected,
          lastHeartbeat: this.lastStudioHeartbeat ? new Date(this.lastStudioHeartbeat).toISOString() : "Never",
          bridgePort: this.port,
          framework: "Bun + Elysia + elysia-mcp",
          queuedCommands: this.commandQueue.length,
          instructions: connected
            ? "Octane Studio is connected and ready to execute commands."
            : "Octane Studio is not connected. Make sure Octane Studio is open, HTTP requests are allowed in Game Settings > Security, and the Octane MCP plugin is toggled ON.",
        };

        return {
          content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
        };
      }
    );

    // 2. Execute Arbitrary Luau Code
    targetMcp.tool(
      "execute_luau",
      "Execute arbitrary Luau code inside Octane Studio edit mode. Captures print/warn output, returns values, and creates undo waypoints.",
      {
        code: z.string().describe("Luau source code to execute"),
      },
      async ({ code }) => {
        try {
          const resp = await this.sendCommand("execute_luau", { code });
          let formattedOutput = "";
          if (resp.logs && resp.logs.length > 0) {
            formattedOutput += `[Output Logs]:\n${resp.logs.join("\n")}\n\n`;
          }
          formattedOutput += `[Return Values]:\n${JSON.stringify(resp.result, null, 2)}`;
          return {
            content: [{ type: "text", text: formattedOutput }],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `Execution failed: ${err.message}` }],
          };
        }
      }
    );

    // 3. Read Script Source
    targetMcp.tool(
      "read_script",
      "Read the Luau source code of a Script, LocalScript, or ModuleScript in the DataModel.",
      {
        path: z.string().describe("Dot or slash path to the script (e.g. 'ServerScriptService.Main' or 'Workspace.Door.Script')"),
      },
      async ({ path }) => {
        try {
          const resp = await this.sendCommand("read_script", { path });
          return {
            content: [
              {
                type: "text",
                text: resp.result.source || "",
              },
            ],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to read script at '${path}': ${err.message}` }],
          };
        }
      }
    );

    // 4. Write / Update Script Source
    targetMcp.tool(
      "write_script",
      "Update the Luau source code of an existing script, or create a new Script/LocalScript/ModuleScript if it doesn't exist.",
      {
        path: z.string().describe("Path to the script (e.g. 'ServerScriptService.GameManager')"),
        source: z.string().describe("Complete Luau source code to write"),
        className: z
          .enum(["Script", "LocalScript", "ModuleScript"])
          .optional()
          .describe("If creating a new script, its ClassName (defaults to Script)"),
      },
      async ({ path, source, className }) => {
        try {
          const resp = await this.sendCommand("write_script", { path, source, className });
          return {
            content: [
              {
                type: "text",
                text: `Successfully wrote script at '${path}' (${resp.result.className}).`,
              },
            ],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to write script at '${path}': ${err.message}` }],
          };
        }
      }
    );

    // 5. Inspect Hierarchy Tree
    targetMcp.tool(
      "get_tree",
      "Inspect the instance hierarchy tree in Octane Studio under a given root path (e.g. 'Workspace', 'ServerScriptService', 'ReplicatedStorage', or 'game').",
      {
        rootPath: z
          .string()
          .default("Workspace")
          .describe("Root instance path to inspect. Use 'game' or empty string to see all top-level services."),
        maxDepth: z
          .number()
          .min(1)
          .max(6)
          .default(2)
          .describe("Maximum recursive depth to explore (default 2)"),
        classNameFilter: z
          .string()
          .optional()
          .describe("Optional class name filter (e.g. 'Script' or 'Model')"),
      },
      async ({ rootPath, maxDepth, classNameFilter }) => {
        try {
          const resp = await this.sendCommand("get_tree", { rootPath, maxDepth, classNameFilter });
          return {
            content: [{ type: "text", text: JSON.stringify(resp.result, null, 2) }],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to get hierarchy tree: ${err.message}` }],
          };
        }
      }
    );

    // 6. Get Current Selection in Studio
    targetMcp.tool(
      "get_selection",
      "Get the list of instances currently selected in the Octane Studio Explorer or 3D viewport.",
      {},
      async () => {
        try {
          const resp = await this.sendCommand("get_selection", {});
          return {
            content: [{ type: "text", text: JSON.stringify(resp.result, null, 2) }],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to get selection: ${err.message}` }],
          };
        }
      }
    );

    // 7. Set Selection in Studio
    targetMcp.tool(
      "set_selection",
      "Select one or more instances in Octane Studio by their paths.",
      {
        paths: z.array(z.string()).describe("Array of instance paths to select"),
      },
      async ({ paths }) => {
        try {
          const resp = await this.sendCommand("set_selection", { paths });
          return {
            content: [
              {
                type: "text",
                text: `Selected ${resp.result.selectedCount} instance(s).`,
              },
            ],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to set selection: ${err.message}` }],
          };
        }
      }
    );

    // 8. Create Instance
    targetMcp.tool(
      "create_instance",
      "Create a new Instance (e.g. Part, Model, Folder, RemoteEvent, ScreenGui) under a parent instance with specified properties.",
      {
        className: z.string().describe("Roblox ClassName to create (e.g. 'Part', 'Folder', 'Model', 'RemoteEvent')"),
        parentPath: z.string().describe("Path to the parent instance (e.g. 'Workspace', 'ReplicatedStorage')"),
        name: z.string().optional().describe("Optional name for the new instance"),
        properties: z
          .record(z.any())
          .optional()
          .describe("Key-value dictionary of initial properties (e.g. { Anchored: true, Size: { X: 4, Y: 1, Z: 4 } })"),
      },
      async ({ className, parentPath, name, properties }) => {
        try {
          const resp = await this.sendCommand("create_instance", {
            className,
            parentPath,
            name,
            properties: properties || {},
          });
          return {
            content: [
              {
                type: "text",
                text: `Created ${className} '${resp.result.name}' at path '${resp.result.path}'.`,
              },
            ],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to create instance: ${err.message}` }],
          };
        }
      }
    );

    // 9. Delete Instance
    targetMcp.tool(
      "delete_instance",
      "Delete (destroy) an instance at the specified path.",
      {
        path: z.string().describe("Path to the instance to delete (e.g. 'Workspace.OldPart')"),
      },
      async ({ path }) => {
        try {
          const resp = await this.sendCommand("delete_instance", { path });
          return {
            content: [{ type: "text", text: `Successfully deleted '${path}'.` }],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to delete instance at '${path}': ${err.message}` }],
          };
        }
      }
    );

    // 10. Get Properties of an Instance
    targetMcp.tool(
      "get_properties",
      "Read specified properties of an instance at a given path.",
      {
        path: z.string().describe("Path to the instance"),
        properties: z
          .array(z.string())
          .describe("Array of property names to read (e.g. ['Name', 'Position', 'Size', 'Anchored'])"),
      },
      async ({ path, properties }) => {
        try {
          const resp = await this.sendCommand("get_properties", { path, properties });
          return {
            content: [{ type: "text", text: JSON.stringify(resp.result, null, 2) }],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to get properties: ${err.message}` }],
          };
        }
      }
    );

    // 11. Set Properties of an Instance
    targetMcp.tool(
      "set_properties",
      "Modify properties of an instance at a given path.",
      {
        path: z.string().describe("Path to the instance"),
        properties: z
          .record(z.any())
          .describe("Key-value dictionary of properties to set (e.g. { Anchored: true, Transparency: 0.5 })"),
      },
      async ({ path, properties }) => {
        try {
          const resp = await this.sendCommand("set_properties", { path, properties });
          return {
            content: [
              {
                type: "text",
                text: `Successfully updated properties on '${path}': ${JSON.stringify(resp.result.updated)}`,
              },
            ],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `Failed to set properties: ${err.message}` }],
          };
        }
      }
    );
  }

  async start() {
    this.startElysiaServer();
    const transport = new StdioServerTransport();
    await this.stdioMcp.connect(transport);
    console.error("[OctaneMCPPlus] Stdio MCP server connected and ready.");
  }
}
