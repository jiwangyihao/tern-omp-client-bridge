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
local function button(state, verb, label, enabled)
	local admitted = enabled and not state.closed and state.owner ~= nil and state.panelId ~= nil
	local props = {
		key = verb, text = verb == "hide" and "" or label, aria = label, title = label,
		icon = actionIcons[verb], variant = verb == "paste" and "primary" or (verb == "upload" and "default" or "quiet"),
		disabled = not admitted and "Reconnect Bridge from the owning remote OMP session." or false,
	}
	if admitted then
		props.href = "omp-bridge-panel://" .. state.owner .. "/" .. state.panelId .. "/" .. verb
		props.actions = { click = "open" }
	end
	return ui.node("button", props)
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
	if (state.snapshot and tern.now() >= state.expiresAt)
		or (state.awaitingUntil and tern.now() >= state.awaitingUntil) then
		state.snapshot = nil
		state.awaitingUntil = nil
		state.expired = true
		return true
	end
	return false
end

tern.block.define("panel", {
	font = "sans",
	init = function(cx, args, _saved)
		-- These routing locators are not credentials. Never restore a stale snapshot.
		local owner = type(args) == "table" and args[1] or nil
		local panelId = type(args) == "table" and args[2] or nil
		local clientId = type(args) == "table" and args[3] or nil
		if not routeId(owner) or not routeId(panelId) or not routeId(clientId) then return {} end
		local state = { owner = owner, panelId = panelId, clientId = clientId, awaitingUntil = tern.now() + SNAPSHOT_TTL_MS }
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
							state.awaitingUntil = nil
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
		local current = not state.closed and state.snapshot or nil
		local connected = current ~= nil and current.connected
		local waiting = current == nil and state.awaitingUntil ~= nil and not state.closed
		local main = {
			ui.node("text", { role = "omp.client-bridge.panel-owner", text = (state.owner or "") .. "/" .. (state.panelId or ""), hidden = true }),
			ui.node("row", { key = "header", gap = "sm", align = "center", wrap = true }, {
				with(ui.text(ui.span("Bridge", "title")), { grow = 1 }),
				ui.badge(connected and "Connected" or (waiting and "Connecting" or "Offline"), connected and "success" or (waiting and "pending" or "muted")),
				button(state, "hide", "Hide Bridge", state.owner ~= nil and state.panelId ~= nil),
			}),
		}
		if not current then
			if waiting then
				table.insert(main, ui.node("col", { key = "session", gap = "sm" }, {
					ui.node("spinner", { style = "orbit", label = "Connecting to the remote session" }),
					ui.node("skeleton", { shape = "rows", rows = 3, aria = "Waiting for Bridge session details" }),
				}))
			else
				table.insert(main, ui.node("empty", {
					key = "session", icon = "link", tone = state.expired and "warning" or "muted",
					title = state.expired and "Session unavailable" or "No remote session",
					text = "Open Bridge from the owning remote OMP session. Actions stay unavailable until fresh session details arrive.",
				}))
			end
			return { main = ui.col(main), dock = ui.col({}) }
		end
		table.insert(main, ui.node("col", { key = "session", gap = "sm" }, {
			muted("Source · this device"),
			with(ui.text(current.source), { title = current.source }),
			muted("Destination · remote OMP workspace"),
			with(ui.text(ui.span(current.target, "strong")), { title = current.target }),
			ui.node("buttons", { label = "Send to remote OMP", variant = "joined" }, {
				button(state, "paste", "Paste to remote", connected),
				button(state, "upload", "Upload file…", connected),
			}),
		}))
		if current.error or not connected then
			table.insert(main, ui.node("empty", {
				key = "connection-error", variant = "inline", tone = current.error and "error" or "warning",
				title = current.error and "Bridge needs attention" or "Remote session offline",
				text = current.error or "Reconnect from the owning remote OMP session to enable actions.",
			}))
		end
		local devices = {}
		for index, device in current.devices do
			table.insert(devices, ui.node("col", { key = "device-" .. tostring(index), gap = "xs" }, {
				ui.node("row", { gap = "sm", wrap = true }, {
					with(ui.text(ui.span(device.name, "strong")), { grow = 1, title = device.name }),
					ui.badge(device.online and "Online" or "Offline", device.online and "success" or "muted"),
				}),
				muted(device.platform .. (device.bound and " · Agent target" or " · Not bound")),
			}))
		end
		if current.devicesMore > 0 then table.insert(devices, muted(tostring(current.devicesMore) .. " more; open Devices.")) end
		if #devices == 0 then
			table.insert(devices, ui.node("empty", {
				variant = "inline", icon = "monitor", title = "No devices available",
				text = "Open Devices to connect an agent device. Binding requires confirmation in this window.",
			}))
		end
		table.insert(main, ui.node("col", { key = "devices", gap = "sm" }, {
			ui.node("row", { gap = "sm", justify = "between", wrap = true }, {
				ui.text(ui.span("Agent device", "strong")),
				button(state, "devices", "Devices…", connected),
			}),
			with(muted(current.agent), { title = current.agent }),
			with(ui.section("Available devices", {
				ui.node("scroll", { key = "entries", max = { h = "8lines" }, gap = "md", aria = "Available agent devices" }, devices),
			}), { key = "available", collapsible = true, collapsed = true }),
		}))

		local transfers = {}
		local phaseLabels = { captured = "Captured", uploading = "Uploading", ready = "Ready", attached = "Handed to OMP", failed = "Failed", cancelled = "Cancelled" }
		for index, transfer in current.transfers do
			local progress = transfer.totalBytes > 0 and math.min(transfer.bytesSent / transfer.totalBytes, 1) or nil
			local detail = bytes(transfer.bytesSent) .. (transfer.totalBytes > 0 and " / " .. bytes(transfer.totalBytes) or " / unknown")
			local tone = transfer.phase == "failed" and "error" or (transfer.phase == "attached" and "success" or (transfer.phase == "uploading" and "accent" or "muted"))
			local parts = {
				with(ui.text(ui.span(transfer.name, "strong")), { title = transfer.name }),
				ui.badge(phaseLabels[transfer.phase] or transfer.phase, tone),
			}
			if transfer.phase == "uploading" then
				table.insert(parts, ui.progress(progress, detail))
			else
				table.insert(parts, muted(detail))
			end
			if transfer.error then table.insert(parts, ui.text(ui.span(transfer.error, "error"))) end
			table.insert(transfers, ui.node("col", { key = "transfer-" .. tostring(index), gap = "xs" }, parts))
		end
		if current.transfersMore > 0 then table.insert(transfers, muted(tostring(current.transfersMore) .. " more; open Transfers.")) end
		if #transfers == 0 then
			table.insert(transfers, ui.node("empty", {
				variant = "inline", icon = "inbox", title = "No transfers yet",
				text = "Paste or upload a file to send it to the remote OMP workspace.",
			}))
		end
		table.insert(main, ui.node("col", { key = "transfers", gap = "sm" }, {
			ui.node("row", { gap = "sm", justify = "between", wrap = true }, {
				ui.text(ui.span("Transfers", "strong")),
				button(state, "transfers", "History…", connected),
			}),
			ui.node("scroll", { key = "entries", max = { h = "12lines" }, gap = "md", aria = "Recent transfers" }, transfers),
		}))
		if current.approvals > 0 then
			table.insert(main, ui.node("row", { key = "approvals", gap = "sm", wrap = true }, {
				ui.badge(tostring(current.approvals) .. " pending", "pending"),
				button(state, "approvals", "Review approvals…", connected),
			}))
		end
		return { main = ui.col(main), dock = ui.col({}) }
	end,
})

require('./setup-ui/view').register('setup')
