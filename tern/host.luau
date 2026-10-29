-- SPDX-License-Identifier: MPL-2.0
-- Display-only host block. Authenticated broker records carry public snapshots.
-- Native link actions still run only in the clicking window; no broadcast effects.
local ui = tern.ui
local MAX_PAYLOAD = 65536
local MAX_TEXT = 240
local MAX_DEVICES = 32
local MAX_TRANSFERS = 20
local MAX_BYTES = 9007199254740991

local function object(value)
	return type(value) == "table" and value ~= tern.json.null
end

local function routeId(value)
	return type(value) == "string" and #value > 0 and #value <= 128
		and value:match("^[%w_-][%w_.-]*$") ~= nil
end

local function text(value, fallback)
	if type(value) ~= "string" or value == "" then return fallback end
	-- Bound before sanitizing, and never cut a UTF-8 codepoint in half.
	local last = #value > MAX_TEXT and MAX_TEXT - #"…" or #value
	if last < #value then
		while last > 0 do
			local byte = string.byte(value, last + 1)
			if byte < 128 or byte >= 192 then break end
			last -= 1
		end
	end
	local clipped = value:sub(1, last)
	if utf8.len(clipped) == nil then return fallback end
	clipped = clipped:gsub("%c", " ")
	return clipped .. (last < #value and "…" or "")
end

local function count(value, maximum)
	if type(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then return 0 end
	return math.floor(math.clamp(value, 0, maximum))
end

local function snapshot(value, state)
	if not object(value) or value.owner ~= state.owner or value.panelId ~= state.panelId then return nil end
	local result = {
		source = text(value.source, "Unknown client"),
		target = text(value.target, "No remote OMP target"),
		agent = text(value.agent, "Unbound"),
		connected = value.connected == true,
		error = text(value.error, nil),
		approvals = count(value.approvals, 9999),
		devices = {}, transfers = {}, devicesMore = 0, transfersMore = 0,
	}
	if object(value.devices) then
		for index = 1, math.min(#value.devices, MAX_DEVICES) do
			local device = value.devices[index]
			if object(device) then
				table.insert(result.devices, {
					name = text(device.name, "Unnamed device"),
					platform = text(device.platform, "Unknown platform"),
					online = device.online == true,
					bound = device.bound == true,
				})
			end
		end
		result.devicesMore = math.max(0, #value.devices - MAX_DEVICES)
	end
	if object(value.transfers) then
		for index = 1, math.min(#value.transfers, MAX_TRANSFERS) do
			local transfer = value.transfers[index]
			if object(transfer) then
				table.insert(result.transfers, {
					id = text(transfer.id, ""),
					name = text(transfer.name, "Unnamed transfer"),
					phase = text(transfer.phase, "Unknown"),
					bytesSent = count(transfer.bytesSent, MAX_BYTES),
					totalBytes = count(transfer.totalBytes, MAX_BYTES),
					error = text(transfer.error, nil),
				})
			end
		end
		result.transfersMore = math.max(0, #value.transfers - MAX_TRANSFERS)
	end
	return result
end

local function with(node, props)
	node.p = node.p or {}
	for key, value in props do node.p[key] = value end
	return node
end

local function muted(value)
	return ui.text(ui.span(value, "muted"))
end

local actionIcons = { paste = "clipboard", upload = "file-plus", devices = "monitor", transfers = "history", approvals = "shield", hide = "x" }
local function icon(name, tone)
	return ui.node("icon", { name = name, tone = tone or "muted" })
end

local function button(state, verb, label, enabled, detail)
	local props = { key = verb, aria = verb == "hide" and "Hide Bridge" or label, title = label, class = "bridge-action bridge-" .. verb, attrs = { ["aria-disabled"] = not enabled } }
	if enabled and state.owner and state.panelId then
		props.href = "omp-bridge-panel://" .. state.owner .. "/" .. state.panelId .. "/" .. verb
		props.actions = { click = "open" }
	end
	local children = { icon(actionIcons[verb]) }
	if verb ~= "hide" then
		local caption = detail and ui.lines({ muted(detail), ui.text(ui.span(label, "strong")) }) or ui.text(label)
		table.insert(children, with(caption, { grow = 1 }))
	end
	if verb == "devices" then table.insert(children, icon("chev-r")) end
	return ui.el("button", props, children)
end

local function bytes(value)
	if value >= 1073741824 then return string.format("%.1f GiB", value / 1073741824) end
	if value >= 1048576 then return string.format("%.1f MiB", value / 1048576) end
	if value >= 1024 then return string.format("%.1f KiB", value / 1024) end
	return string.format("%.0f B", value)
end

local SNAPSHOT_TTL_MS = 15000
local EXPIRY_CHECK_MS = 1000
local owned = {}

local function hostEndpoint()
	local ok, config = pcall(function() return tern.json.decode(tern.fs.read(tern.plugin.data .. "/config.json", 16384)) end)
	if not ok or not object(config) or type(config.serverControlFile) ~= "string" or config.serverControlFile == "" then return nil end
	local readOk, endpoint = pcall(function() return tern.json.decode(tern.fs.read(config.serverControlFile, 16384)) end)
	if not readOk or not object(endpoint) or type(endpoint.url) ~= "string"
		or not endpoint.url:match("^http://127%.0%.0%.1:%d+/?$")
		or type(endpoint.token) ~= "string" or #endpoint.token < 16 then return nil end
	return { url = endpoint.url:gsub("/$", ""), token = endpoint.token }
end

local function hostClosed(state)
	if state.closed then return end
	state.closed = true
	if state.timer then state.timer:cancel() end
	local endpoint = state.endpoint
	if endpoint then
		pcall(tern.fetch, endpoint.url .. "/v1/panels/closed", {
			method = "POST", timeout_ms = 5000,
			headers = { Authorization = "Bearer " .. endpoint.token, ["Content-Type"] = "application/json" },
			body = tern.json.encode({ clientId = state.clientId, owner = state.owner, panelId = state.panelId }),
		}, function() end)
	end
end

tern.on("pane_exited", function(ev)
	local state = owned[ev.pane]
	if state then owned[ev.pane] = nil; hostClosed(state) end
end)

local function expire(state)
	if state.snapshot and tern.now() >= state.expiresAt then
		state.snapshot = nil
		state.expired = true
		return true
	end
	return false
end

tern.block.define("panel", {
	init = function(cx, args, _saved)
		-- These routing locators are not credentials. Never restore a stale snapshot.
		local owner = type(args) == "table" and args[1] or nil
		local panelId = type(args) == "table" and args[2] or nil
		local clientId = type(args) == "table" and args[3] or nil
		if not routeId(owner) or not routeId(panelId) or not routeId(clientId) then return {} end
		local state = { owner = owner, panelId = panelId, clientId = clientId }
		owned[cx.pane] = state -- Host lifecycle metadata only; never a window lookup.
		local function tick()
			if state.closed then return end
			local changed = expire(state)
			if changed then cx:render() end
			state.endpoint = hostEndpoint()
			local endpoint = state.endpoint
			local function nextTick()
				if not state.closed then state.timer = tern.timer(EXPIRY_CHECK_MS, tick) end
			end
			if not endpoint then nextTick(); return end
			local url = endpoint.url .. "/v1/panels?clientId=" .. clientId .. "&owner=" .. owner .. "&panelId=" .. panelId
			local started = pcall(tern.fetch, url, { timeout_ms = 5000, headers = { Authorization = "Bearer " .. endpoint.token } }, function(response)
				if state.closed then return end
				if not response.error and response.status == 200 and type(response.body) == "string" and #response.body <= MAX_PAYLOAD + 1024 then
					local parsed, value = pcall(tern.json.decode, response.body)
					if parsed and object(value) then
						if value.closed == true then
							owned[cx.pane] = nil
							hostClosed(state)
							cx:exit(0)
							return
						end
						local current = snapshot(value.snapshot, state)
						if current then
							state.snapshot, state.expiresAt, state.expired = current, tern.now() + SNAPSHOT_TTL_MS, false
							cx:render()
						end
					end
				end
				nextTick()
			end)
			if not started then nextTick() end
		end
		state.timer = tern.timer(0, tick)
		return state
	end,
	title = function() return "Bridge" end,
	save = function() return {} end,
	key = function() return false end,
	view = function(state, _cx)
		expire(state)
		local current = state.snapshot
		local connected = current ~= nil and current.connected
		local main = {
			ui.node("text", { role = "omp.client-bridge.panel-owner", text = (state.owner or "") .. "/" .. (state.panelId or ""), hidden = true }),
			with(ui.row({
				with(icon("plug", "accent"), { role = "bridge-mark" }),
				with(ui.text(ui.span("Bridge", "strong")), { role = "bridge-title", grow = 1 }),
				with(ui.badge(connected and "Connected" or "Offline", connected and "success" or "muted"), { role = "bridge-status" }),
				button(state, "hide", "Hide Bridge", state.owner ~= nil and state.panelId ~= nil),
			}), { role = "bridge-header" }),
		}
		if not current then
			table.insert(main, with(ui.row({
				icon("link"),
				ui.lines({
					ui.text(ui.span(state.expired and "Connection lost" or "No remote session", "strong")),
					muted("Open Bridge from a remote OMP session."),
				}),
			}), { role = "bridge-empty" }))
			return { main = with(ui.col(main), { role = "omp-client-bridge.panel" }), dock = ui.col({}) }
		end
		table.insert(main, with(ui.col({
			with(ui.row({
				with(icon("terminal", "accent"), { role = "bridge-workspace-icon" }),
				with(ui.lines({
					ui.text(ui.span(current.target, "strong")),
					muted("Remote OMP workspace"),
				}), { grow = 1 }),
			}), { role = "bridge-workspace-heading" }),
			ui.node("item", { label = current.source, detail = "This device", icon = "laptop", role = "bridge-source" }),
			with(ui.row({
				button(state, "paste", "Paste to remote", connected),
				button(state, "upload", "Upload file", connected),
			}), { role = "bridge-actions" }),
		}), { role = "bridge-workspace" }))
		if current.error then
			table.insert(main, with(ui.row({ icon("warn", "error"), ui.text(ui.span(current.error, "error")) }), { role = "bridge-error" }))
		end
		table.insert(main, button(state, "devices", current.agent, connected, "Agent device"))

		local devices = {}
		for index, device in current.devices do
			table.insert(devices, ui.node("item", {
				key = "device-" .. tostring(index),
				label = device.name,
				detail = device.platform .. (device.bound and " · Agent target" or ""),
				value = ui.span(device.online and "Online" or "Offline", device.online and "success" or "muted"),
				icon = device.platform == "linux" and "server" or "laptop",
				role = "bridge-device",
			}))
		end
		if current.devicesMore > 0 then table.insert(devices, muted(tostring(current.devicesMore) .. " more; open Devices.")) end
		if #devices > 0 then
			table.insert(main, with(ui.section("Available devices", devices), { key = "device-list", collapsible = true, collapsed = true }))
		end

		local transfers = {}
		local phaseLabels = { captured = "Captured", uploading = "Uploading", ready = "Ready", attached = "Handed to OMP", failed = "Failed", cancelled = "Cancelled" }
		for index, transfer in current.transfers do
			local progress = transfer.totalBytes > 0 and math.min(transfer.bytesSent / transfer.totalBytes, 1) or nil
			local detail = bytes(transfer.bytesSent) .. (transfer.totalBytes > 0 and " / " .. bytes(transfer.totalBytes) or " / unknown")
			local tone = transfer.phase == "failed" and "error" or (transfer.phase == "attached" and "success" or "muted")
			local parts = {
				with(ui.row({
					icon("file"),
					with(ui.text(ui.span(transfer.name, "strong")), { grow = 1 }),
					ui.badge(phaseLabels[transfer.phase] or transfer.phase, tone),
				}), { role = "bridge-transfer-heading" }),
				ui.progress(progress, detail),
			}
			if transfer.error then table.insert(parts, ui.text(ui.span(transfer.error, "error"))) end
			table.insert(transfers, with(ui.col(parts), { key = "transfer-" .. tostring(index), role = "bridge-transfer" }))
		end
		if current.transfersMore > 0 then table.insert(transfers, muted(tostring(current.transfersMore) .. " more; open Transfers.")) end
		table.insert(main, with(ui.row({
			with(muted("Transfers"), { grow = 1 }),
			button(state, "transfers", "History", connected),
		}), { role = "bridge-section-header" }))
		if #transfers == 0 then
			table.insert(transfers, with(ui.row({ icon("inbox"), muted("No transfers yet") }), { role = "bridge-empty-transfers" }))
		end
		table.insert(main, with(ui.col(transfers), { role = "bridge-transfers" }))
		if current.approvals > 0 then
			table.insert(main, button(state, "approvals", "Review approvals · " .. tostring(current.approvals), connected))
		end
		return {
			main = with(ui.col(main), { role = "omp-client-bridge.panel" }),
			dock = ui.col({}),
		}
	end,
})

require('./setup-ui/view').register('setup')
