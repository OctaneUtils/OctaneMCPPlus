import fs from "fs";
import path from "path";

const target = path.join(process.cwd(), "node_modules", "elysia", "dist", "cookies.mjs");
if (fs.existsSync(target)) {
  const content = fs.readFileSync(target, "utf8");
  if (!content.includes("serializeCookie")) {
    fs.writeFileSync(
      target,
      'export { Cookie, createCookieJar, parseCookie, serializeCookie } from "./cookies.js";\n'
    );
    console.error("[Octane MCP] Patched elysia/dist/cookies.mjs for Node.js ESM compatibility.");
  }
}
