--[[
    Octane MCP Bridge Plugin
    Compatible with Octane Studio (2021 Luau / Roblox Studio Revival)
    
    This plugin connects your Octane Studio session to the local Octane MCP Server,
    allowing AI coding assistants (like Antigravity, Claude, Cursor) to:
      - Read & write scripts directly in edit mode
      - Inspect the Explorer hierarchy and current selections
      - Create and edit parts, models, and UI instances
      - Execute arbitrary Luau code and inspect output logs
--]]

local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Selection = game:GetService("Selection")

local SERVER_URL = "http://127.0.0.1:3002"
local POLL_ENDPOINT = SERVER_URL .. "/poll"
local RESPOND_ENDPOINT = SERVER_URL .. "/respond"

local isConnected = false
local isPolling = false

-- Octane 2021 Luau uses Roblox's native scheduler globals: wait, spawn, delay

-- Safe HTTP Request Helper
local function doHttpRequest(options)
    local ok, res = pcall(function()
        return HttpService:RequestAsync(options)
    end)
    if not ok then
        -- Fallback for older engines that prefer PostAsync / GetAsync
        local fallbackOk, fallbackRes = pcall(function()
            if options.Method == "POST" then
                local body = options.Body or ""
                local resBody = HttpService:PostAsync(options.Url, body, Enum.HttpContentType.ApplicationJson)
                return { Success = true, StatusCode = 200, Body = resBody }
            else
                local resBody = HttpService:GetAsync(options.Url)
                return { Success = true, StatusCode = 200, Body = resBody }
            end
        end)
        if fallbackOk then
            return true, fallbackRes
        else
            return false, res -- Return the original error for diagnosis
        end
    end
    return true, res
end

-- Create Toolbar & Button in Studio
local toolbar = plugin:CreateToolbar("Octane MCP")
local toggleButton = toolbar:CreateButton(
    "Toggle MCP Bridge",
    "Connect or disconnect Octane Studio from the local AI MCP Bridge",
    "rbxassetid://4458901886" -- generic link/network icon
)
pcall(function()
    toggleButton.ClickableWhenViewportHidden = true
end)

-- Utility: Path Resolver
local function resolvePath(pathStr)
    if not pathStr or pathStr == "" or pathStr == "game" or pathStr == "DataModel" then
        return game
    end

    -- Replace slashes with dots
    local normalized = string.gsub(pathStr, "/", ".")
    local parts = string.split(normalized, ".")
    local current = game
    local startIndex = 1

    if parts[1] == "game" then
        startIndex = 2
    end

    for i = startIndex, #parts do
        local partName = parts[i]
        if partName ~= "" then
            local nextChild = current:FindFirstChild(partName)

            -- If at root, also check top-level services
            if not nextChild and current == game then
                local ok, service = pcall(function()
                    return game:GetService(partName)
                end)
                if ok and service then
                    nextChild = service
                end
            end

            if not nextChild then
                return nil, string.format("Child '%s' not found under '%s'", partName, current:GetFullName())
            end
            current = nextChild
        end
    end

    return current
end

local function getFullPath(inst)
    if not inst then return "" end
    if inst == game then return "game" end
    local parts = {}
    local curr = inst
    while curr and curr ~= game do
        table.insert(parts, 1, curr.Name)
        curr = curr.Parent
    end
    return table.concat(parts, ".")
end

-- Utility: Serialization for JSON
local function serializeValue(val)
    local t = typeof(val)
    if t == "Vector3" then
        return { _type = "Vector3", X = val.X, Y = val.Y, Z = val.Z }
    elseif t == "Vector2" then
        return { _type = "Vector2", X = val.X, Y = val.Y }
    elseif t == "Color3" then
        return { _type = "Color3", R = val.R, G = val.G, B = val.B }
    elseif t == "UDim2" then
        return { _type = "UDim2", X = { Scale = val.X.Scale, Offset = val.X.Offset }, Y = { Scale = val.Y.Scale, Offset = val.Y.Offset } }
    elseif t == "CFrame" then
        local x, y, z = val.Position.X, val.Position.Y, val.Position.Z
        return { _type = "CFrame", X = x, Y = y, Z = z }
    elseif t == "Instance" then
        return { _type = "Instance", Name = val.Name, ClassName = val.ClassName, Path = getFullPath(val) }
    elseif t == "EnumItem" then
        return tostring(val)
    elseif t == "table" then
        local s = {}
        for k, v in pairs(val) do
            s[tostring(k)] = serializeValue(v)
        end
        return s
    else
        return val
    end
end

-- Utility: Deserialization / Value Parser
local function parseValue(val)
    if typeof(val) == "table" then
        if val.X ~= nil and val.Y ~= nil and val.Z ~= nil and val._type == "Vector3" or (val.X ~= nil and val.Y ~= nil and val.Z ~= nil and val._type == nil and val.R == nil) then
            return Vector3.new(tonumber(val.X) or 0, tonumber(val.Y) or 0, tonumber(val.Z) or 0)
        elseif val.R ~= nil and val.G ~= nil and val.B ~= nil then
            local r, g, b = tonumber(val.R) or 0, tonumber(val.G) or 0, tonumber(val.B) or 0
            if r > 1 or g > 1 or b > 1 then
                return Color3.fromRGB(r, g, b)
            else
                return Color3.new(r, g, b)
            end
        elseif val.X ~= nil and val.Y ~= nil and val._type == "UDim2" then
            return UDim2.new(val.X.Scale or 0, val.X.Offset or 0, val.Y.Scale or 0, val.Y.Offset or 0)
        end
    end

    if typeof(val) == "string" and string.match(val, "^Enum%.") then
        local parts = string.split(val, ".")
        if #parts == 3 and Enum[parts[2]] and Enum[parts[2]][parts[3]] then
            return Enum[parts[2]][parts[3]]
        end
    end

    return val
end

-- Handlers for incoming MCP actions
local Handlers = {}

-- 1. Execute arbitrary Luau
Handlers.execute_luau = function(params)
    local code = params.code
    if not code or code == "" then
        return false, nil, "No Luau code provided"
    end

    local fn, compileErr = loadstring(code)
    if not fn then
        return false, nil, "Syntax Error: " .. tostring(compileErr)
    end

    local logs = {}
    local oldEnv = getfenv(fn)
    local env = setmetatable({
        print = function(...)
            local parts = {}
            for i = 1, select("#", ...) do
                table.insert(parts, tostring(select(i, ...)))
            end
            table.insert(logs, table.concat(parts, " "))
        end,
        warn = function(...)
            local parts = {}
            for i = 1, select("#", ...) do
                table.insert(parts, tostring(select(i, ...)))
            end
            table.insert(logs, "[WARN] " .. table.concat(parts, " "))
        end,
    }, { __index = oldEnv })

    setfenv(fn, env)

    ChangeHistoryService:SetWaypoint("Octane MCP: Before Execution")
    local results = table.pack(pcall(fn))
    ChangeHistoryService:SetWaypoint("Octane MCP: After Execution")

    local ok = results[1]
    if not ok then
        return false, nil, tostring(results[2]), logs
    end

    local returns = {}
    for i = 2, results.n do
        table.insert(returns, serializeValue(results[i]))
    end

    return true, returns, nil, logs
end

-- 2. Read Script Source
Handlers.read_script = function(params)
    local path = params.path
    local inst, err = resolvePath(path)
    if not inst then
        return false, nil, err
    end

    if not inst:IsA("LuaSourceContainer") then
        return false, nil, string.format("Instance at '%s' is a '%s', not a Script/LocalScript/ModuleScript", path, inst.ClassName)
    end

    return true, {
        name = inst.Name,
        className = inst.ClassName,
        path = getFullPath(inst),
        source = inst.Source,
    }
end

-- 3. Write / Create Script Source
Handlers.write_script = function(params)
    local path = params.path
    local source = params.source or ""
    local className = params.className or "Script"

    local inst, err = resolvePath(path)
    if not inst then
        -- Attempt to create under parent
        local parts = string.split(string.gsub(path, "/", "."), ".")
        if #parts < 2 then
            return false, nil, "Cannot create root service: " .. path
        end

        local scriptName = parts[#parts]
        table.remove(parts, #parts)
        local parentPath = table.concat(parts, ".")
        local parentInst, parentErr = resolvePath(parentPath)
        if not parentInst then
            return false, nil, "Cannot create script; parent path not found: " .. tostring(parentErr)
        end

        local newScript = Instance.new(className)
        newScript.Name = scriptName
        newScript.Source = source
        newScript.Parent = parentInst

        ChangeHistoryService:SetWaypoint("Octane MCP: Create Script " .. scriptName)
        return true, {
            name = newScript.Name,
            className = newScript.ClassName,
            path = getFullPath(newScript),
            created = true,
        }
    end

    if not inst:IsA("LuaSourceContainer") then
        return false, nil, string.format("Cannot write source to '%s' of class '%s'", path, inst.ClassName)
    end

    inst.Source = source
    ChangeHistoryService:SetWaypoint("Octane MCP: Update Script " .. inst.Name)

    return true, {
        name = inst.Name,
        className = inst.ClassName,
        path = getFullPath(inst),
        updated = true,
    }
end

-- 4. Get Hierarchy Tree
Handlers.get_tree = function(params)
    local rootPath = params.rootPath or "Workspace"
    local maxDepth = tonumber(params.maxDepth) or 2
    local filter = params.classNameFilter

    local rootInst, err = resolvePath(rootPath)
    if not rootInst then
        return false, nil, err
    end

    local function buildNode(inst, depth)
        local children = inst:GetChildren()
        local childNodes = {}

        if depth < maxDepth then
            for _, child in ipairs(children) do
                if not filter or child:IsA(filter) or #child:GetChildren() > 0 then
                    table.insert(childNodes, buildNode(child, depth + 1))
                end
            end
        end

        return {
            name = inst.Name,
            className = inst.ClassName,
            path = getFullPath(inst),
            childCount = #children,
            children = depth < maxDepth and childNodes or nil,
        }
    end

    if rootInst == game then
        local services = {}
        for _, child in ipairs(game:GetChildren()) do
            pcall(function()
                if not filter or child:IsA(filter) or #child:GetChildren() > 0 then
                    table.insert(services, buildNode(child, 1))
                end
            end)
        end
        return true, { name = "game", className = "DataModel", services = services }
    else
        return true, buildNode(rootInst, 0)
    end
end

-- 5. Selection
Handlers.get_selection = function()
    local selected = Selection:Get()
    local result = {}
    for _, item in ipairs(selected) do
        table.insert(result, {
            name = item.Name,
            className = item.ClassName,
            path = getFullPath(item),
        })
    end
    return true, result
end

Handlers.set_selection = function(params)
    local paths = params.paths or {}
    local instances = {}
    for _, p in ipairs(paths) do
        local inst = resolvePath(p)
        if inst and inst ~= game then
            table.insert(instances, inst)
        end
    end
    Selection:Set(instances)
    return true, { selectedCount = #instances }
end

-- 6. Create Instance
Handlers.create_instance = function(params)
    local className = params.className
    local parentPath = params.parentPath
    local name = params.name
    local properties = params.properties or {}

    local parentInst, err = resolvePath(parentPath)
    if not parentInst then
        return false, nil, "Parent path not found: " .. tostring(err)
    end

    local ok, inst = pcall(function()
        return Instance.new(className)
    end)
    if not ok or not inst then
        return false, nil, "Failed to instantiate class: " .. tostring(className)
    end

    if name then
        inst.Name = name
    end

    for propName, propValue in pairs(properties) do
        pcall(function()
            inst[propName] = parseValue(propValue)
        end)
    end

    inst.Parent = parentInst
    ChangeHistoryService:SetWaypoint("Octane MCP: Create " .. inst.ClassName)

    return true, {
        name = inst.Name,
        className = inst.ClassName,
        path = getFullPath(inst),
    }
end

-- 7. Delete Instance
Handlers.delete_instance = function(params)
    local path = params.path
    local inst, err = resolvePath(path)
    if not inst then
        return false, nil, err
    end
    if inst == game or inst.Parent == nil then
        return false, nil, "Cannot delete root DataModel"
    end

    local fullName = inst:GetFullName()
    inst:Destroy()
    ChangeHistoryService:SetWaypoint("Octane MCP: Delete " .. fullName)
    return true, { deleted = fullName }
end

-- 8. Get / Set Properties
Handlers.get_properties = function(params)
    local path = params.path
    local propNames = params.properties or {}
    local inst, err = resolvePath(path)
    if not inst then
        return false, nil, err
    end

    local result = {}
    for _, prop in ipairs(propNames) do
        local ok, val = pcall(function()
            return inst[prop]
        end)
        if ok then
            result[prop] = serializeValue(val)
        else
            result[prop] = "[Property Not Found or Inaccessible]"
        end
    end

    return true, result
end

Handlers.set_properties = function(params)
    local path = params.path
    local properties = params.properties or {}
    local inst, err = resolvePath(path)
    if not inst then
        return false, nil, err
    end

    local updated = {}
    for propName, propVal in pairs(properties) do
        local ok, applyErr = pcall(function()
            inst[propName] = parseValue(propVal)
        end)
        if ok then
            table.insert(updated, propName)
        else
            warn(string.format("[Octane MCP] Failed to set %s on %s: %s", propName, path, tostring(applyErr)))
        end
    end

    ChangeHistoryService:SetWaypoint("Octane MCP: Set Properties on " .. inst.Name)
    return true, { updated = updated }
end

-- Dispatch incoming command
local function dispatchCommand(cmd)
    local id = cmd.id
    local action = cmd.action
    local params = cmd.params or {}

    print(string.format("[Octane MCP] >>> Executing command: %s (%s)", tostring(action), tostring(id)))

    local handler = Handlers[action]
    local success, result, err, logs

    if handler then
        local pcallOk, hSuccess, hResult, hErr, hLogs = pcall(function()
            return handler(params)
        end)
        if pcallOk then
            success = hSuccess
            result = hResult
            err = hErr
            logs = hLogs
        else
            success = false
            err = "Handler crashed: " .. tostring(hSuccess)
        end
    else
        success = false
        err = "Unknown MCP action: " .. tostring(action)
    end

    print(string.format("[Octane MCP] Execution complete: %s, success=%s", tostring(action), tostring(success)))

    -- Send result back to bridge server
    local payload = {
        id = id,
        success = success,
        result = result,
        error = err,
        logs = logs,
    }

    local encoded = HttpService:JSONEncode(payload)
    local postOk, postRes = doHttpRequest({
        Url = RESPOND_ENDPOINT,
        Method = "POST",
        Headers = { ["Content-Type"] = "application/json" },
        Body = encoded,
    })

    if postOk and postRes and (postRes.Success or postRes.StatusCode == 200) then
        print(string.format("[Octane MCP] <<< Result posted successfully for %s", tostring(id)))
    else
        warn(string.format("[Octane MCP] !!! Failed to post result for %s: %s", tostring(id), tostring(postRes)))
    end
end

-- Long-poll loop
local function startPolling()
    if isPolling then return end
    isPolling = true

    print("[Octane MCP] Connecting to bridge at " .. SERVER_URL .. "...")

    local failCount = 0

    spawn(function()
        while isConnected do
            local success, response = doHttpRequest({
                Url = POLL_ENDPOINT,
                Method = "GET",
                Headers = { ["Content-Type"] = "application/json" },
            })

            if success and response and (response.Success or response.StatusCode == 200) then
                failCount = 0
                local decodeOk, data = pcall(function()
                    return HttpService:JSONDecode(response.Body)
                end)

                if decodeOk and data then
                    if data.status == "command" and data.command then
                        dispatchCommand(data.command)
                        wait(0.05)
                    else
                        -- Idle: wait 0.5s before next check (fast, responsive, zero socket hangs)
                        wait(0.5)
                    end
                else
                    wait(0.5)
                end
            else
                failCount = failCount + 1
                local errStr = tostring(response)
                -- Silently retry on transient Roblox loopback errors without spamming output
                if not string.find(errStr, "ROBLOX resources") and failCount >= 3 then
                    warn("[Octane MCP] Bridge server unreachable: " .. errStr)
                end
                wait(1.5)
            end
        end
        isPolling = false
        print("[Octane MCP] Disconnected.")
    end)
end

-- Toggle button connection
local function toggleConnection()
    isConnected = not isConnected
    pcall(function()
        toggleButton:SetActive(isConnected)
    end)

    if isConnected then
        print("[Octane MCP] Status: ACTIVE")
        startPolling()
    else
        print("[Octane MCP] Status: STOPPED")
    end
end

toggleButton.Click:Connect(toggleConnection)

-- Auto-connect on Studio startup
delay(1, function()
    if not isConnected then
        toggleConnection()
    end
end)

print("[Octane MCP] Plugin loaded. Toggle via Plugins toolbar if needed.")
