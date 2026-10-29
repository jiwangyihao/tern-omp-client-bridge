-- SPDX-License-Identifier: MPL-2.0
-- Display/input only. The clicking window owns consent, SSH and installation.
-- Input protocol: docs.stencil.so/tern/elements/input.md and /protocol/input.md.
-- Current `tern plugin types` adds BlockDef.features (older website prose does not).
local ui = tern.ui
local FIELD = "main.ssh"
local PHASES = {
	choose = "Choose a host", checking = "Checking SSH", review = "Review installation",
	installing = "Installing", ready = "Ready", awaiting_session = "Waiting for an OMP session",
	failed = "Setup needs attention", interrupted = "Setup interrupted",
}

local function object(v) return type(v) == "table" and v ~= tern.json.null end
local function integer(v) return type(v) == "number" and v >= 0 and v <= 9007199254740991 and v % 1 == 0 end
local function routeId(v)
	return type(v) == "string" and #v > 0 and #v <= 128 and v:match("^[A-Za-z0-9_-][A-Za-z0-9_.-]*$") ~= nil
end
local function plain(v, fallback)
	if type(v) ~= "string" or v == "" then return fallback end
	local last = math.min(#v, 240)
	while last < #v and last > 0 and string.byte(v, last + 1) >= 128 and string.byte(v, last + 1) < 192 do last -= 1 end
	local result = v:sub(1, last)
	if utf8.len(result) == nil then return fallback end
	return result:gsub("%c", " ") .. (last < #v and "…" or "")
end
local function fieldText(v)
	return type(v) == "string" and #v <= 255 and not v:find("%c") and utf8.len(v) ~= nil
end
local function destination(v)
	-- Accept the controller's normalized SSH URI, but no other scheme, path,
	-- password, option or command text. The window still validates the target.
	if not fieldText(v) or #v == 0 then return false end
	local authority = v:sub(1, 6) == "ssh://" and v:sub(7) or v
	return #authority > 0 and authority:sub(1, 1) ~= "-"
		and not authority:find("[^A-Za-z0-9_.@:%+%-%[%]]")
		and not authority:match("^[^@]*:[^@]*@") and not authority:find("@%-")
end
local function encode(v)
	return (v:gsub("[^A-Za-z0-9_.~-]", function(c) return string.format("%%%02X", string.byte(c)) end))
end
local function parse(value, state)
	if not object(value) or value.owner ~= state.owner or value.panelId ~= state.panelId
		or not integer(value.revision) or value.revision < state.revision or not PHASES[value.phase] then return nil end
	local result = {
		revision = value.revision, phase = value.phase, stage = plain(value.stage, PHASES[value.phase]),
		message = plain(value.message, ""), error = plain(value.error, nil), hosts = {},
		selectedLabel = plain(value.selectedLabel, "No host selected"),
		selectedAddress = destination(value.selectedAddress) and value.selectedAddress or nil,
		ssh = destination(value.ssh) and value.ssh or "", platform = plain(value.platform, nil),
	}
	for _, name in { "canCheck", "canInstall", "canRecover", "canRetry", "canChoose", "busy" } do result[name] = value[name] == true end
	if object(value.hosts) then
		local seen, manual = {}, false
		for index = 1, math.min(#value.hosts, 32) do
			local host = value.hosts[index]
			if object(host) and type(host.key) == "string" and #host.key > 0 and #host.key <= 128
				and not host.key:find("%c") and utf8.len(host.key) ~= nil and not seen[host.key] then
				seen[host.key] = true
				local isManual = host.manual == true
				if not isManual or not manual then
					table.insert(result.hosts, { key = host.key, label = plain(host.label, "Unnamed host"), detail = plain(host.detail, ""), manual = isManual })
				end
				manual = manual or isManual
			end
		end
	end
	return result
end
local function expire(state)
	if state.snapshot and not state.expired and tern.now() >= state.expiresAt then
		state.expired = true
		return true
	end
	return false
end
local function live(state)
	expire(state)
	return state.snapshot ~= nil and not state.expired
end
local function frozen(current)
	return current.busy or current.phase == "checking" or current.phase == "installing"
end
local function showsInput(state)
	local current = state.snapshot
	return current ~= nil and not state.picker and ((current.phase == "choose" and current.canCheck) or current.phase == "checking"
		or (state.editing == true and (current.phase == "review" or current.phase == "failed" or current.phase == "interrupted")))
end
local function editable(state)
	return live(state) and showsInput(state) and not frozen(state.snapshot) and state.snapshot.canCheck
end

-- All editor offsets are UTF-16, never byte offsets. A split surrogate is invalid.
local function boundaries(value)
	local bytes, positions, units = { [0] = 1 }, { 0 }, 0
	for offset, point in utf8.codes(value) do
		bytes[units] = offset
		units += point > 65535 and 2 or 1
		table.insert(positions, units)
	end
	bytes[units] = #value + 1
	return bytes, positions, units
end
-- Word chords skip separators then one word; Meta chords reach line boundaries.
-- Keep non-ASCII codepoints whole even while a destination is being edited.
local function wordBoundary(value, bytes, positions, cursor, direction)
	local index = table.find(positions, cursor)
	local function word(at)
		local byte = string.byte(value, bytes[positions[at]])
		return byte ~= nil and (byte >= 128 or string.char(byte):match("[%w_]") ~= nil)
	end
	if direction < 0 then
		while index > 1 and not word(index - 1) do index -= 1 end
		while index > 1 and word(index - 1) do index -= 1 end
	else
		while index < #positions and not word(index) do index += 1 end
		while index < #positions and word(index) do index += 1 end
	end
	return positions[index]
end
local function replace(state, from, to, text, cursor)
	if not fieldText(text) or not integer(from) or not integer(to) or from > to then return false end
	local bytes = boundaries(state.ssh)
	if not bytes[from] or not bytes[to] then return false end
	local nextText = state.ssh:sub(1, bytes[from] - 1) .. text .. state.ssh:sub(bytes[to])
	if not fieldText(nextText) then return false end
	local nextBytes = boundaries(nextText)
	if not integer(cursor) or not nextBytes[cursor] then return false end
	if nextText ~= state.ssh then
		if #state.history == 32 then table.remove(state.history, 1) end
		table.insert(state.history, { text = state.ssh, cursor = state.cursor, anchor = state.anchor })
		state.ssh, state.dirty = nextText, true
	end
	state.cursor, state.anchor = cursor, nil
	return true
end
local function undo(state)
	local old = table.remove(state.history)
	if not old then return false end
	state.ssh, state.cursor, state.anchor, state.dirty = old.text, old.cursor, old.anchor, true
	return true
end
local function key(state, k)
	if not editable(state) or not state.focused then return false end
	local bytes, positions, length = boundaries(state.ssh)
	local from, to = state.cursor, state.cursor
	if state.anchor then from, to = math.min(from, state.anchor), math.max(to, state.anchor) end
	local previous, following = 0, length
	for _, position in positions do
		if position < state.cursor then previous = position end
		if position > state.cursor then following = position; break end
	end
	if (k.ctrl or k.meta) and k.name == "a" then state.anchor, state.cursor = 0, length; return true end
	if (k.ctrl or k.meta) and k.name == "z" and not k.shift then return undo(state) end
	if k.name == "escape" then state.focused = false; return true end
	local moving = nil
	if k.name == "home" or k.name == "begin" then moving = 0
	elseif k.name == "end" then moving = length
	elseif k.name == "left" then moving = not k.shift and from ~= to and from or previous
	elseif k.name == "right" then moving = not k.shift and from ~= to and to or following end
	if moving ~= nil then
		if k.meta then moving = (k.name == "left" or k.name == "home" or k.name == "begin") and 0 or length
		elseif (k.ctrl or k.alt) and (k.name == "left" or k.name == "right") then
			moving = wordBoundary(state.ssh, bytes, positions, state.cursor, k.name == "left" and -1 or 1)
		end
		if k.shift then state.anchor = state.anchor or state.cursor else state.anchor = nil end
		state.cursor = moving
		return true
	end
	if k.name == "backspace" or k.name == "delete" then
		if from == to then
			if k.name == "backspace" then
				from = k.meta and 0 or ((k.ctrl or k.alt) and wordBoundary(state.ssh, bytes, positions, state.cursor, -1) or previous)
			else
				to = k.meta and length or ((k.ctrl or k.alt) and wordBoundary(state.ssh, bytes, positions, state.cursor, 1) or following)
			end
		end
		return replace(state, from, to, "", from)
	end
	if type(k.text) == "string" and not k.ctrl and not k.meta and not k.alt and fieldText(k.text) then
		local _, _, added = boundaries(k.text)
		return replace(state, from, to, k.text, from + added)
	end
	-- Enter is intentionally inert: typing never becomes consent or execution.
	return false
end
local function with(node, props)
	node.p = node.p or {}
	for name, value in props do node.p[name] = value end
	return node
end
local function label(value, style) return ui.text(ui.span(value, style or "muted")) end
local function button(state, action, caption, enabled, value, keyName, style)
	local props = { key = keyName or action, aria = caption, class = "setup-action setup-" .. (style or "secondary"), attrs = { ["aria-disabled"] = not enabled } }
	if enabled and state.owner then
		props.href = "omp-bridge-setup://" .. state.owner .. "/" .. state.panelId .. "/" .. string.format("%.0f", state.revision) .. "/" .. action
			.. (value ~= nil and "/" .. encode(value) or "")
		props.actions = { click = "open" }
	end
	return ui.el("button", props, { ui.text(caption) })
end
local function localButton(action, caption, enabled, expanded)
	return ui.el("button", { key = action, aria = caption, class = "setup-action setup-quiet",
		attrs = { ["aria-disabled"] = not enabled, ["aria-expanded"] = expanded },
		actions = enabled and { click = "setup-" .. action } or nil }, { ui.text(caption) })
end

local function nextStep(current)
	if current.phase ~= "awaiting_session" then return nil, nil end
	if current.stage == "awaiting-local-endpoint" then
		return "Connect this device", current.message
	elseif current.stage == "awaiting-host-plugin" then
		return "Reload the host plugin", current.message
	elseif current.stage == "awaiting-service-upgrade" then
		return "Update Bridge services", current.message
	end
	return "Open Bridge from remote OMP", "On the host above, open a remote OMP conversation with the Bridge extension loaded, then open Bridge there. An existing compatible conversation is sufficient."
end

local function register(kind)
	assert(kind == "panel" or kind == "setup", "Unknown setup block kind")
	local role = tern.plugin.id .. "." .. kind
	tern.block.define(kind, {
		features = { "edit", "undo" },
		init = function(cx, args, _saved)
			local owner, panelId = object(args) and args[1] or nil, object(args) and args[2] or nil
			local state = { revision = 0, ssh = "", cursor = 0, dirty = false, history = {} }
			if not routeId(owner) or not routeId(panelId) then return state end
			state.owner, state.panelId = owner, panelId
			local function tick()
				local running = false
				for _, pane in tern.pane.list() do if pane.pane == cx.pane then running = true; break end end
				if not running then return end
				if expire(state) then cx:render() end
				tern.timer(5000, tick)
			end
			tern.timer(5000, tick)
			return state
		end,
		title = function() return "Bridge Setup" end,
		-- No live snapshots, input, credentials or permissions are persisted.
		save = function() return {} end,
		key = function(state, k, cx)
			local changed = key(state, k)
			if changed and not state.focused then cx:frame({ { "focus", tern.json.null } }) end
			return changed
		end,
		event = function(state, ev, cx)
			if not state.owner then return end
			if ev.ev == "action" and ev.act == "setup-snapshot" then
				if type(ev.value) ~= "string" or #ev.value > 65536 then return end
				local ok, value = pcall(tern.json.decode, ev.value)
				if not ok then return end
				local nextSnapshot = parse(value, state)
				if not nextSnapshot then return end
				if not state.snapshot or nextSnapshot.revision > state.revision then
					state.picker, state.editing, state.details = false, false, false
					if state.focused then state.focused = false; cx:frame({ { "focus", tern.json.null } }) end
					state.ssh, state.dirty, state.history, state.anchor = nextSnapshot.ssh, false, {}, nil
					local _, _, length = boundaries(state.ssh)
					state.cursor = length
				end
				state.snapshot, state.revision = nextSnapshot, nextSnapshot.revision
				state.expiresAt, state.expired = tern.now() + 15000, false
				return
			end
			if ev.ev == "action" and live(state) and not frozen(state.snapshot) then
				if ev.act == "setup-change" and state.snapshot.canChoose and state.snapshot.phase ~= "ready" and state.snapshot.phase ~= "awaiting_session" then
					state.picker = true
				elseif ev.act == "setup-cancel" then
					state.picker = false
				elseif ev.act == "setup-edit" and state.snapshot.canCheck
					and (state.snapshot.phase == "review" or state.snapshot.phase == "failed" or state.snapshot.phase == "interrupted") then
					state.editing, state.picker = true, false
				elseif ev.act == "setup-details" then
					state.details = not state.details
				end
				return
			end
			if ev.id ~= FIELD or not editable(state) then return end
			if ev.ev == "focus" then
				state.focused = true
				cx:frame({ { "focus", FIELD } })
			elseif ev.ev == "edit" then
				local _, _, length = boundaries(state.ssh)
				if ev.len ~= length then return end
				replace(state, ev.from, ev.to, ev.text, ev.cursor)
			elseif ev.ev == "undo" then undo(state) end
		end,
		view = function(state)
			local connected = live(state)
			local current = state.snapshot
			local enabled = connected and not frozen(current)
			local close = button(state, "hide", "Close setup", state.owner ~= nil, nil, nil, "quiet")
			close.c = { ui.node("icon", { name = "x" }) }
			close.p.title = "Close sidebar; background installation continues"
			local main = {
				with(ui.row({
					ui.node("icon", { name = "plug" }),
					with(label("Bridge Setup", "strong"), { grow = 1 }), close,
				}), { key = "header", role = "setup-header" }),
			}
			if not current then
				table.insert(main, with(label("Waiting for the owner window…"), { key = "message", role = "setup-message" }))
			else
				local input = showsInput(state)
				local needsHost = current.phase == "choose" and not current.canCheck and not current.busy
				local nextTitle, nextMessage = nextStep(current)
				local failed = current.phase == "failed" or current.phase == "interrupted"
				local complete = current.phase == "ready" or current.phase == "awaiting_session"
				local subtitle = current.phase == "choose" and current.canCheck and "Check the connection" or PHASES[current.phase]
				table.insert(main, with(label(nextTitle or subtitle), { key = "subtitle", role = "setup-subtitle" }))
				if not connected then
					table.insert(main, with(label("Connection lost. Waiting for the owner window.", "warning"), { key = "offline", role = "setup-message" }))
				end
				local heading = { ui.node("icon", { name = "server" }), with(label(current.selectedLabel, "strong"), { grow = 1 }) }
				if not complete then
					table.insert(heading, localButton(state.picker and "cancel" or "change", state.picker and "Cancel" or "Change", enabled and current.canChoose, state.picker == true))
				end
				local target = { with(ui.row(heading), { key = "heading", role = "setup-target-heading" }) }
				local metadata = {}
				if current.selectedAddress and (not input or current.selectedAddress ~= state.ssh) and current.selectedAddress ~= current.selectedLabel then
					table.insert(metadata, (not input and state.ssh == current.selectedAddress and "SSH · " or "Tern · ") .. current.selectedAddress)
				end
				if not input and state.ssh ~= "" and state.ssh ~= current.selectedAddress and state.ssh ~= current.selectedLabel then
					table.insert(metadata, "SSH · " .. state.ssh)
				end
				if #metadata == 0 and input then table.insert(metadata, "Separate Bridge SSH connection") end
				if current.platform then table.insert(metadata, current.platform) end
				if #metadata > 0 then table.insert(target, with(label(table.concat(metadata, " · ")), { key = "meta", role = "setup-target-meta" })) end
				if not needsHost then table.insert(main, with(ui.col(target), { key = "target", role = "setup-target" })) end
				if (needsHost or state.picker) and not complete then
					local hosts = {}
					for index, host in current.hosts do
						local option = button(state, "select", host.label, enabled and current.canChoose, host.key, "host-" .. tostring(index), "host-option")
						option.p.role = "setup-host-option"
						option.c = { ui.col(host.detail ~= "" and { ui.text(host.label), label(host.detail) } or { ui.text(host.label) }) }
						table.insert(hosts, option)
					end
					table.insert(main, with(ui.col(hosts), { key = "hosts", role = "setup-hosts" }))
				end
				if input then
					table.insert(main, with(ui.row({ with(label("SSH destination"), { role = "setup-label" }) }), { key = "form", role = "setup-form" }))
					table.insert(main, ui.node("input", { key = "ssh", role = "setup-ssh", aria = "SSH destination", text = state.ssh,
						cursor = state.cursor, anchor = state.anchor, readonly = not editable(state), placeholder = "alias or user@host", sendable = false }))
				end
				if frozen(current) then
					table.insert(main, with(ui.progress(nil, current.stage), { key = "progress", role = "setup-progress" }))
				elseif failed then
					table.insert(main, with(label(current.error or current.message, "error"), { key = "error", role = "setup-error" }))
				elseif complete and (nextMessage or current.message) ~= "" then
					table.insert(main, with(label(nextMessage or current.message), { key = "message", role = "setup-message" }))
				end
				if state.dirty then table.insert(main, with(label("Check the edited destination before installing."), { key = "dirty", role = "setup-message" })) end
				local actions = {}
				if input and not frozen(current) then
					table.insert(actions, button(state, "check", "Check SSH", enabled and current.canCheck and destination(state.ssh), state.ssh, nil, "primary"))
				elseif current.phase == "review" and not state.picker then
					table.insert(main, with(ui.col({
						with(label("This device · Private runtime and Bridge client"), { role = "setup-scope-row" }),
						with(label("Remote host · Broker, OMP and Tern integrations"), { role = "setup-scope-row" }),
						with(label("No sudo or session restarts. Bind a device to authorize native tools under its local safety rules."), { role = "setup-scope-row" }),
						with(label("Install approves this scope for the target above."), { role = "setup-footer" }),
					}), { key = "consent", role = "setup-consent" }))
					table.insert(actions, button(state, "install", "Install", enabled and current.canInstall and not state.dirty and destination(state.ssh), state.ssh, nil, "primary"))
					table.insert(actions, localButton("edit", "Edit SSH", enabled and current.canCheck))
					if current.canRecover then
						table.insert(actions, button(state, "recover", "Review recovery", enabled and not state.dirty and destination(state.ssh), state.ssh))
						table.insert(main, with(label("Unknown-owner recovery requires separate confirmation in this device's window."), { key = "recovery", role = "setup-message" }))
					end
				elseif failed and not state.picker then
					table.insert(actions, button(state, "retry", "Retry", enabled and current.canRetry and not state.dirty, nil, nil, "primary"))
					table.insert(actions, localButton("edit", "Edit SSH", enabled and current.canCheck))
				end
				if #actions > 0 then table.insert(main, with(ui.row(actions), { key = "actions", role = "setup-actions" })) end
				if not state.picker and not needsHost and not frozen(current) and not failed and not complete and current.message ~= "" then
					table.insert(main, with(ui.row({ localButton("details", state.details and "Less detail" or "Details", enabled, state.details == true) }), { key = "footer", role = "setup-footer" }))
					if state.details then table.insert(main, with(label(current.message), { key = "message", role = "setup-message" })) end
				end
			end
			return { main = with(ui.col(main), { role = role }), dock = ui.col({}) }
		end,
	})
end
return { register = register }
