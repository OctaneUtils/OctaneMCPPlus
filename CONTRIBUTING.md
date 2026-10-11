# Contributing to Octane MCP

Thank you for your interest in contributing to **Octane MCP**!

## Development Setup

### Prerequisites
- [Bun](https://bun.sh/) (v1.0+)
- Octane Studio (2021 Luau build)

### Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/octane-mcp.git
   cd octane-mcp
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

3. Run the automated integration test suite:
   ```bash
   bun test
   ```

4. Run the live status diagnostic tool:
   ```bash
   bun run status
   ```

---

## Luau Engine Constraints

Octane is a 2021 Luau revival. When contributing code to the Studio plugin ([`plugin/OctaneMCP.lua`](./plugin/OctaneMCP.lua)), keep the following in mind:

- **No `task` library**: Use Roblox's standard globals (`wait`, `spawn`, `delay`, `coroutine`).
- **HTTP Polling**: Do not introduce long HTTP connection timeouts to `localhost`; short polling ($0.5\text{s}$) prevents cURL socket timeout heuristics in Roblox Studio.
- **Undo / Redo**: Always record checkpoints with `ChangeHistoryService:SetWaypoint(...)` before and after mutating the DataModel.

---

## Submitting Pull Requests

1. Fork the repo and create your branch from `main`:
   ```bash
   git checkout -b feat/my-new-tool
   ```
2. Write clean, readable code and ensure all tests pass (`bun test`).
3. Commit your changes with clear, descriptive commit messages.
4. Open a Pull Request with a summary of what your PR introduces.
