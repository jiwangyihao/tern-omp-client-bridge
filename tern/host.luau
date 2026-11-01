-- SPDX-License-Identifier: MPL-2.0
-- Display/input host block. Authenticated broker records carry public snapshots.
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

local function generation(value)
	return type(value) == "string" and #value <= 32 and value:match("^[1-9][0-9]*$") ~= nil
end

local function choiceKey(value)
	if value == "none" then return true end
	if type(value) ~= "string" or not value:match("^d[1-9][0-9]?$") then return false end
	return tonumber(value:sub(2)) <= MAX_DEVICES
end

local function selection(value, state)
	if not object(value) or value.owner ~= state.owner or value.panelId ~= state.panelId
		or not generation(value.generation) or type(value.available) ~= "boolean"
		or not object(value.options) or #value.options < 1 or #value.options > MAX_DEVICES + 1 then return nil end
	local result = { generation = value.generation, available = value.available, current = value.current, options = {} }
	local seen, size = {}, 0
	for index in value.options do
		if type(index) ~= "number" or index % 1 ~= 0 or index < 1 or index > #value.options then return nil end
		size += 1
	end
	if size ~= #value.options then return nil end
	for _, option in value.options do
		if not object(option) or not choiceKey(option.key) or seen[option.key]
			or type(option.label) ~= "string" or type(option.detail) ~= "string" or type(option.disabled) ~= "boolean" then return nil end
		seen[option.key] = true
		table.insert(result.options, {
			key = option.key, label = text(option.label, "Unnamed device"),
			detail = text(option.detail, ""), disabled = option.disabled,
		})
	end
	if not seen.none or (not (value.current == "" and not value.available)
		and (not choiceKey(value.current) or not seen[value.current])) then return nil end
	return result
end

local function sameSelection(left, right)
	if left.available ~= right.available or left.current ~= right.current or #left.options ~= #right.options then return false end
	for index, option in left.options do
		local other = right.options[index]
		if option.key ~= other.key or option.label ~= other.label or option.detail ~= other.detail or option.disabled ~= other.disabled then return false end
	end
	return true
end

local function clearChoice(state)
	state.pendingChoice, state.choiceActive, state.choiceOpen = nil, nil, false
end

local function offeredChoice(state, key)
	if state.selection then
		for _, option in state.selection.options do if option.key == key then return option end end
	end
	return nil
end

local function with(node, props)
	node.p = node.p or {}
	for key, value in props do node.p[key] = value end
	return node
end

local function muted(value)
	return ui.text(ui.span(value, "muted"))
end

local actionIcons = { paste = "clipboard", upload = "push", transfers = "history", approvals = "shield" }
local function button(state, verb, label, enabled)
	local admitted = enabled and not state.closed and state.owner ~= nil and state.panelId ~= nil
	local props = {
		key = verb, text = label, aria = label, title = label, size = "sm",
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
	clearChoice(state)
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
	local changed = false
	if (state.snapshot and tern.now() >= state.expiresAt)
		or (state.awaitingUntil and tern.now() >= state.awaitingUntil) then
		state.snapshot = nil
		state.awaitingUntil = nil
		state.expired = true
		clearChoice(state)
		changed = true
	end
	if state.selection and not state.selectionExpired and tern.now() >= state.selectionExpiresAt then
		state.selectionExpired = true
		clearChoice(state)
		changed = true
	end
	return changed
end

local function selectionReady(state)
	expire(state)
	return not state.closed and state.snapshot ~= nil and state.snapshot.connected
		and state.selection ~= nil and state.selection.available and not state.selectionExpired and not state.selectionRevoked
end

local function deviceField(state)
	local enabled = selectionReady(state)
	local offer = state.selection
	local selected = offeredChoice(state, state.pendingChoice or (offer and offer.current))
	local options = {}
	for _, option in offer and offer.options or {} do
		table.insert(options, { value = option.key, label = option.label, detail = option.detail, disabled = option.disabled })
	end
	local apply = { key = "apply", role = "bridge-apply", text = "Use device", aria = "Apply agent device", variant = "default", size = "sm",
		disabled = "Choose a different online device first." }
	if not enabled then apply.disabled = "Waiting for current device choices from the owning window." end
	if enabled and selected and not selected.disabled and selected.key ~= offer.current then
		apply.disabled = false
		apply.href = "omp-bridge-panel://" .. state.owner .. "/" .. state.panelId .. "/bind/" .. offer.generation .. "/" .. selected.key
		apply.actions = { click = "open" }
	end
	apply.hidden = apply.disabled ~= false
	local meta = "Unavailable"
	if enabled and selected then
		if selected.key ~= offer.current then meta = "Not applied"
		elseif selected.key == "none" then meta = "Agent-host only"
		elseif selected.disabled then meta = "Offline"
		elseif selected.detail:find(" · This device", 1, true) then meta = "This device"
		else meta = "Online" end
	end
	return ui.node("field", { key = "device", role = "bridge-agent", label = "Agent device" }, {
		with(muted(meta), { key = "meta", role = "bridge-device-meta" }),
		ui.node("icon", { key = "icon", role = "bridge-select-icon", name = "monitor", size = 14 }),
		ui.node("select", { key = "choice-" .. (offer and offer.generation or "waiting"), aria = "Agent device", variant = "field", size = "sm", grow = 1,
			options = options, value = selected and selected.key or nil, open = enabled and state.choiceOpen == true,
			active = state.choiceActive, placeholder = offer and offer.current == "" and state.snapshot and state.snapshot.agent or "Waiting for device choices",
			min = { w = 0 }, max = { w = 1 },
			title = selected and (selected.label .. (selected.detail ~= "" and " · " .. selected.detail or "")) or nil,
			disabled = not enabled and "Waiting for current device choices from the owning window." or false }),
		ui.node("button", apply),
	})
end

tern.block.define("panel", {
	font = "sans",
	init = function(cx, args, _saved)
		-- These routing locators are not credentials. Never restore a stale snapshot.
		local owner = type(args) == "table" and args[1] or nil
		local panelId = type(args) == "table" and args[2] or nil
		local clientId = type(args) == "table" and args[3] or nil
		if not routeId(owner) or not routeId(panelId) or not routeId(clientId) then return {} end
		local state = { owner = owner, panelId = panelId, clientId = clientId, awaitingUntil = tern.now() + SNAPSHOT_TTL_MS,
			hostName = text(args[4], "Remote host"), workspaceName = text(args[5], "Remote session"), sessionTitle = text(args[6], nil) }
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
							expire(state)
							if not current.connected then clearChoice(state) end
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
	key = function(state, k)
		if not selectionReady(state) or not state.choiceOpen then return false end
		if k.name == "escape" then state.choiceOpen = false; return true end
		if k.name == "up" or k.name == "down" then
			local options = state.selection.options
			local index = 0
			for i, option in options do
				if option.key == (state.choiceActive or state.pendingChoice or state.selection.current) then index = i; break end
			end
			local step = k.name == "up" and -1 or 1
			if index == 0 and step < 0 then index = #options + 1 end
			index += step
			while index >= 1 and index <= #options do
				if not options[index].disabled then state.choiceActive = options[index].key; break end
				index += step
			end
			return true
		end
		if k.name == "enter" then
			local option = offeredChoice(state, state.choiceActive)
			if option and not option.disabled then state.pendingChoice = option.key end
			state.choiceOpen = false
			return true -- Choosing is local; only the explicit Apply link reaches the window.
		end
		return false
	end,
	event = function(state, ev, _cx)
		if not state.owner or state.closed then return end
		expire(state)
		if ev.ev == "action" and ev.act == "bridge-device-selection" then
			if type(ev.value) ~= "string" or #ev.value > MAX_PAYLOAD then return end
			local ok, value = pcall(tern.json.decode, ev.value)
			if not ok then return end
			local nextSelection = selection(value, state)
			if not nextSelection then return end
			local previous = state.selection
			if previous then
				local old, new = previous.generation, nextSelection.generation
				if #new < #old or (#new == #old and new < old) then return end
				if new == old then
					if not sameSelection(previous, nextSelection) then
						state.selectionRevoked = true
						clearChoice(state)
					end
					if state.selectionRevoked then return end
				else
					clearChoice(state)
					state.selectionRevoked = false
				end
			end
			state.selection = nextSelection
			state.selectionExpiresAt, state.selectionExpired = tern.now() + SNAPSHOT_TTL_MS, false
			if not selectionReady(state) then clearChoice(state) end
			return
		end
		if not selectionReady(state) or ev.id ~= "main.device.choice-" .. state.selection.generation then return end
		if ev.ev == "change" and type(ev.value) == "string" then
			local option = offeredChoice(state, ev.value)
			if option and not option.disabled then
				state.pendingChoice, state.choiceActive, state.choiceOpen = option.key, option.key, false
			end
		elseif ev.ev == "toggle" and type(ev.open) == "boolean" then
			state.choiceOpen = ev.open
		end
	end,
	view = function(state, _cx)
		expire(state)
		local current = not state.closed and state.snapshot or nil
		local connected = current ~= nil and current.connected
		local waiting = current == nil and state.awaitingUntil ~= nil and not state.closed
		local main = {
			ui.node("text", { role = "omp.client-bridge.panel-owner", text = (state.owner or "") .. "/" .. (state.panelId or ""), hidden = true }),
			ui.node("row", { key = "header", role = "bridge-identity", align = "center" }, {
				ui.node("col", { role = "bridge-host-mark" }, { ui.node("icon", { name = "server", size = 18 }) }),
				ui.node("col", { role = "bridge-host-info", grow = 1, min = { w = 0 } }, {
					with(ui.text(state.hostName or "Remote host"), { role = "bridge-host-name", title = state.hostName }),
					with(muted("Remote OMP"), { role = "bridge-host-kind" }),
				}),
				with(ui.text(connected and "Connected" or (waiting and "Connecting" or "Offline")), {
					role = "bridge-status", tone = connected and "success" or (waiting and "pending" or "muted"),
				}),
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
			return { main = with(ui.col(main), { role = "bridge-form" }), dock = ui.col({}) }
		end
		table.insert(main, ui.node("col", { key = "session", role = "bridge-destination" }, {
			ui.node("row", { role = "bridge-workspace", align = "center" }, {
				ui.node("icon", { name = "folder", size = 13 }),
				with(ui.text(state.workspaceName), { title = state.workspaceName }),
			}),
			with(muted(state.sessionTitle or current.target), { role = "bridge-target", title = current.target }),
		}))
		table.insert(main, ui.node("row", { key = "source", role = "bridge-source", justify = "between", align = "center" }, {
			muted("From this device"),
			with(ui.text(ui.span(current.source, "mono muted")), { role = "bridge-source-name", title = "Transfers originate on this device: " .. current.source }),
		}))
		table.insert(main, ui.node("row", { key = "actions", role = "bridge-actions", wrap = true }, {
			button(state, "paste", "Paste", connected),
			button(state, "upload", "Upload…", connected),
		}))
		if current.error or not connected then
			table.insert(main, ui.node("empty", {
				key = "connection-error", variant = "inline", tone = current.error and "error" or "warning",
				title = current.error and "Bridge needs attention" or "Remote session offline",
				text = current.error or "Reconnect from the owning remote OMP session to enable actions.",
			}))
		end
		table.insert(main, deviceField(state))

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
			table.insert(main, ui.node("row", { key = "transfers", role = "bridge-footer", justify = "between", align = "center" }, {
				ui.node("row", { key = "empty", role = "bridge-empty", grow = 1, align = "center" }, {
					ui.node("icon", { name = "inbox", size = 13 }), muted("No transfers yet"),
				}),
				button(state, "transfers", "History…", connected),
			}))
		else
			table.insert(main, ui.node("col", { key = "transfers", role = "bridge-transfer-list", gap = "sm" }, {
				ui.node("row", { gap = "sm", justify = "between", wrap = true }, {
					ui.text(ui.span("Transfers", "strong")),
					button(state, "transfers", "History…", connected),
				}),
				ui.node("scroll", { key = "entries", max = { h = "8lines" }, gap = "md", aria = "Recent transfers" }, transfers),
			}))
		end
		if current.approvals > 0 then
			table.insert(main, ui.node("row", { key = "approvals", gap = "sm", wrap = true }, {
				ui.badge(tostring(current.approvals) .. " pending", "pending"),
				button(state, "approvals", "Review approvals…", connected),
			}))
		end
		return { main = with(ui.col(main), { role = "bridge-form" }), dock = ui.col({}) }
	end,
})

require('./setup-ui/view').register('setup')
