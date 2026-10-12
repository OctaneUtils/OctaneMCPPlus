# Installing the Octane MCP Plugin

This Luau plugin connects your Octane Studio (2021 Luau Revival) session to the local **Octane MCP Server**.

---

### Step 1: Enable HTTP Requests in Octane Studio

Roblox Studio security requires games/places to permit outgoing HTTP traffic:

1. In **Octane Studio**, open your place.
2. In the top Home ribbon, click **Game Settings** (or File > Game Settings).
3. Select the **Security** tab.
4. Toggle **Allow HTTP Requests** to **ON**.
5. Click **Save**.

---

### Step 2: Install the Plugin into Studio

There are two easy ways to install the plugin:

#### Method A: Direct File Copy (Recommended)
1. Copy [OctaneMCP.lua](./OctaneMCP.lua) directly into your Octane plugins folder:
   - **Windows**: `%localappdata%\Octane\Plugins\OctaneMCP.lua`
2. Restart or reload Octane Studio.
3. You will see the **"Toggle MCP Bridge"** button in your Studio `Plugins` toolbar tab!

#### Method B: Save as Local Plugin
1. In Octane Studio, create a new **Script** in `ServerStorage` or `Workspace`.
2. Open [OctaneMCP.lua](./OctaneMCP.lua) and copy its entire contents.
3. Paste the contents into your newly created Script.
4. Rename the Script to `OctaneMCP`.
5. Right-click the Script in the Explorer window and select **Save as Local Plugin...**.
6. Save it to your Plugins directory.

---

### Step 3: Verifying the Connection
1. Ensure the MCP server is running (`bun start`).
2. When Octane Studio opens, the plugin auto-connects to `http://127.0.0.1:3002`.
3. Check the Studio **Output window** (View > Output) to see:
   ```text
   [Octane MCP] Plugin loaded.
   [Octane MCP] Status: ACTIVE
   [Octane MCP] Connecting to bridge at http://127.0.0.1:3002...
   ```
4. You can click the **Toggle MCP Bridge** button in the Plugins toolbar at any time to pause or resume AI assistant access.

---

### Step 4: Configuring In-Studio Settings

Click the **"MCP Settings"** button in your Plugins toolbar to open the dockable settings widget:

- **Bridge Port**: Customize the HTTP and MCP bridge port (defaults to `3002`).
- **Bridge Host IP / Domain**: Point to `127.0.0.1`, `localhost`, or a custom IP if hosting the MCP bridge remotely.
- **Auto-connect on Studio start**: Check or uncheck whether the bridge automatically connects whenever you open Octane Studio.
- **Test Connection**: Pings the bridge `/health` endpoint and shows immediate green/red feedback without needing to open the Output window.
- **Save & Apply**: Saves your configuration persistently across Studio sessions and updates the active bridge connection on the fly.

