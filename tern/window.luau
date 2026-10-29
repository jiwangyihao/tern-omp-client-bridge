-- SPDX-License-Identifier: MPL-2.0
-- Only local window input handlers capture human data. No Carly exports.
local windowId = string.format("%x-%x-%x", math.floor(tern.now() * 1000), math.random(0, 2147483647), math.random(0, 2147483647))
local state = nil
local connection = nil
local statusError = nil
local connectionConfig = nil
local connectionStatus, connectionMessage = "checking", "Checking this device's Bridge endpoint"
local installationVerified = false
local targets = {}
local pending = {}
local operations = {}
local nextResolve = {}
local resolving = {}
local resolved = {}
local pollBusy = false
local action = "plugin.omp-client-bridge."
local clipboardRequest = nil
local filePickerOpen = false
local openApprovals = {}
local transferPhaseLabels = { attached = "Handed to OMP" }
local panelKind = "omp-client-bridge.panel"
local panel = nil
local panelSerial = 0
local panelError = nil
local transferSummary = { failed = 0 }
local transferPhases = {}
local transferDoneUntil, transferDoneCount = 0, 0
local setupRequired = false
local setupBusy = false
local setupChecking = false
local setupInfo = nil
local refreshChrome
local statusByPane = {}
local defaultStatus = { { text = "Checking Bridge", icon = "plug", tone = "muted", command = action .. "setup" } }

-- Action diagnostics use warning level because native info/debug logs are filtered
-- by default. Never serialize user text, paths, URLs, IDs or exception messages.
local diagnosticSerial, diagnosticStart, diagnosticCount = 0, 0, 0
local diagnosticFields = { connected = true, context = true, target = true, panel = true,
	failed = true, sessionMatch = true, hostMatch = true, destinationMatch = true,
	created = true, exception = true, status = true, exitCode = true, timedOut = true, jsonDecoded = true, nativeOk = true, resizing = true }
local function diagnostic(event, fields, operation)
	local now = tern.now()
	if now - diagnosticStart >= 10000 then diagnosticStart, diagnosticCount = now, 0 end
	diagnosticCount += 1
	if diagnosticCount > 41 then return end
	local record = { event = diagnosticCount == 41 and "rate_limited" or event,
		window = windowId, operation = operation or diagnosticSerial, time = math.floor(now) }
	if diagnosticCount <= 40 then
		for key, value in fields or {} do
			if diagnosticFields[key] and ((type(value) == "boolean" and key ~= "exitCode")
				or (key == "status" and type(value) == "number" and value >= 100 and value <= 599)
				or (key == "exitCode" and type(value) == "number" and value >= -2147483648 and value <= 4294967295 and value % 1 == 0)) then record[key] = value end
		end
	end
	-- Diagnostics must not break the interaction if the host logger is unavailable.
	pcall(function() tern.log.warn("[omp-client-bridge:panel]", tern.json.encode(record)) end)
end

-- Native await callbacks receive a fresh window context. Do not route HTTP
-- completion through a second timer queue: stalled receipts stop heartbeat renewal.
local function defer(job)
	tern.sleep(0):next(function(_, err, cx)
		if err then error(err) end
		job(cx)
	end)
end

local function roleNode(root, role)
	local found, ambiguous = nil, false
	local function visit(node)
		if type(node) ~= "table" then return end
		if type(node.p) == "table" and node.p.role == role then
			if found then ambiguous = true else found = node end
		end
		for _, child in node.c or {} do visit(child) end
	end
	visit(root)
	return not ambiguous and found or nil
end

local function panelSurface(cx, pane)
	if not panel or not panel.pane then return false end
	local tree = cx.session:surface(pane or "@focused", { depth = 6, nodes = 64 })
	if type(tree) ~= "table" or type(tree.surface) ~= "table" or tree.surface.role ~= "plugin." .. panelKind then return false end
	local marker = roleNode(tree.main, "omp.client-bridge.panel-owner")
	return marker ~= nil and marker.p.text == windowId .. "/" .. panel.id
end

local function liveTarget(target)
	local current = target and state and state.connected and state.views[target.viewId]
	return type(current) == "table" and current.destinationId == target.destinationId
end

local function report(cx, message)
	diagnostic("reported_error", { connected = state and state.connected == true, panel = panel ~= nil })
	statusError = tostring(message)
	refreshChrome()
	if cx then cx:toast("error", "OMP Client Bridge", statusError) end
end

-- One bounded file read/parse per timer turn; fetch starts on the following turn.
-- Only explicit missing-file errors mean absent metadata. Permission, JSON and
-- endpoint validation failures remain faults, not an invitation to reinstall.
local function readMetadata(path, label)
	local ok, bytes = pcall(tern.fs.read, path, 16384)
	if not ok then
		local failure = tostring(bytes)
		local missing = failure:find("ENOENT", 1, true) or failure:find("os error 2)", 1, true)
			or (tern.runtime.os == "windows" and failure:find("os error 3)", 1, true))
		return nil, missing and "missing" or "error", missing and (label .. " is not available yet") or ("Cannot read " .. label .. "; check this device's Bridge files and permissions, then retry")
	end
	local decoded, value = pcall(tern.json.decode, bytes)
	if not decoded or type(value) ~= "table" then return nil, "error", "Invalid " .. label .. "; inspect this device's Bridge configuration before retrying" end
	return value
end

-- Installation checks paths on this device. Keep them literal in argv/env,
-- including legal filename characters; never consult PATH or guess a socket.
local function configuredNativePath(value, executable)
	if type(value) ~= "string" or value == "" then return nil end
	local valid, controls = pcall(function()
		for _, code in utf8.codes(value) do
			if code < 32 or (code >= 127 and code <= 159) then return true end
		end
		return false
	end)
	if not valid or controls then return nil end
	if tern.runtime.os == "windows" then
		local path = value:gsub("\\", "/")
		-- Extended Windows paths retain their original prefix in the launched argv.
		if path:sub(1, 4) == "//?/" then
			path = path:sub(5)
			if path:sub(1, 4):lower() == "unc/" then path = "//" .. path:sub(5) end
		end
		if path:find('["<>|?*]') or path:sub(-1) == "/"
			or (executable and not path:lower():match("[^/]+%.exe$")) then return nil end
		if path:match("^[A-Za-z]:/[^/]") and not path:sub(3):find(":", 1, true) then return value end
		local server, share, file = path:match("^//([^/]+)/([^/]+)/(.+)$")
		if server and server ~= "." and server ~= ".." and share ~= "." and share ~= ".."
			and file:sub(1, 1) ~= "/" and not path:find(":", 1, true) then return value end
	elseif tern.runtime.os == "macos" or tern.runtime.os == "linux" then
		if value:sub(1, 1) == "/" and value:sub(-1) ~= "/" then return value end
	end
	return nil
end

local function loadConnection()
	local configStep = connectionConfig == nil
	local value, phase, message = readMetadata(configStep and (tern.plugin.data .. "/config.json") or connectionConfig.controlFile,
		configStep and "Bridge configuration" or "local Bridge endpoint metadata")
	if not value then
		connectionConfig = nil
		connectionStatus, connectionMessage = phase == "missing" and "awaiting" or "error", message
		setupRequired = configStep and phase == "missing" and not installationVerified
		statusError = phase == "error" and message or nil
		return false
	end
	if configStep then
		setupRequired = false
		if type(value.controlFile) ~= "string" or value.controlFile == "" or value.controlFile:find("%c") then
			connectionStatus, connectionMessage = "error", "Invalid Bridge control-file configuration; inspect this device's Bridge configuration and retry"
			statusError = connectionMessage
			return false
		end
		connectionConfig = value
		connectionStatus, connectionMessage = "checking", "Checking this device's Bridge endpoint metadata"
		setupRequired = false
		return true
	end
	local ternExecutable = configuredNativePath(connectionConfig.ternExecutable, true)
	local ternPaneSocket = configuredNativePath(connectionConfig.ternPaneSocket, false)
	connectionConfig = nil
	-- Never disclose the local bearer to a remote URL or to the agent host.
	if type(value.url) ~= "string" or not value.url:match("^http://127%.0%.0%.1:%d+/?$") then
		connectionStatus, connectionMessage = "error", "Client UI endpoint must be http://127.0.0.1:PORT; correct this device's Bridge endpoint metadata"
	elseif type(value.token) ~= "string" or value.token == "" then
		connectionStatus, connectionMessage = "error", "Missing local UI token; check this device's Bridge endpoint metadata"
	else
		connection = { url = value.url:gsub("/$", ""), token = value.token, ternExecutable = ternExecutable, ternPaneSocket = ternPaneSocket }
		connectionStatus, connectionMessage = "ready", nil
		setupRequired = false
		return true
	end
	statusError = connectionMessage
	return false
end

local function api(method, path, body, callback)
	local operation = diagnosticSerial
	local panelRequest = path == "/v1/panels/open"
	if not connection then
		callback(nil, connectionMessage or "Bridge endpoint is not connected; reopen Bridge to check its status", nil)
		return
	end
	local options = {
		method = method,
		headers = { Authorization = "Bearer " .. connection.token, ["Content-Type"] = "application/json" },
		timeout_ms = path == "/v1/captures/pick-file" and 130000 or (path == "/v1/captures/clipboard" and 90000 or 10000),
	}
	if body then options.body = tern.json.encode(body) end
	local started = pcall(tern.fetch, connection.url .. path, options, function(response, fresh)
		local value, failure
		if panelRequest then diagnostic("panel.http.response", { status = response.status, failed = response.error ~= nil, context = fresh ~= nil }, operation) end
		if response.error then failure = response.error
		else
			local ok, decoded = pcall(tern.json.decode, response.body)
			if not ok or type(decoded) ~= "table" then failure = "Invalid local UI response"
			elseif response.status < 200 or response.status >= 300 then
				failure = type(decoded.error) == "string" and decoded.error or "Local UI request failed (" .. tostring(response.status) .. ")"
			else value = decoded end
		end
		callback(value, failure, fresh)
	end)
	if not started then
		if panelRequest then diagnostic("panel.http.start_failed", { failed = true }) end
		callback(nil, "Cannot start the local Bridge request; check endpoint metadata and retry", nil)
	end
end

local function release(id)
	api("POST", "/v1/captures/release", { id = id }, function(_, err, cx)
		if err then report(cx, err) end
	end)
end

local function destination(cx, explicit)
	if not cx then return nil, nil, "no_context" end
	if explicit then
		local known = targets[explicit.viewId]
		return known and known.destinationId == explicit.destinationId and explicit or nil
	end
	if panel and panelSurface(cx) then return panel.target end
	local host = cx.hosts:current()
	if not host or host.kind ~= "remote" then return nil, nil, "not_remote" end
	if host.state ~= "connected" then return nil, nil, "host_disconnected" end
	local info = cx.session:pane("@focused")
	if not info or info.kind ~= "agent" then return nil, nil, "not_agent" end
	if info.exited ~= nil then return nil, nil, "agent_exited" end
	local tree = cx.session:surface("@focused", { root = "dock", depth = 16, nodes = 512 })
	if type(tree) ~= "table" or type(tree.surface) ~= "table" or tree.surface.role ~= "omp.session" then return nil, nil, "no_omp_surface" end
	local node = roleNode(tree.dock or tree.main, "omp.client-bridge.destination")
	local href = node and type(node.p.href) == "string" and node.p.href
	local id = href and href:match("^omp%-bridge%-target://([%w_-]+)$")
	if not id or #id > 128 then return nil, "Load the Bridge extension in this OMP session and wait for its destination metadata", "no_locator" end
	local viewId = windowId .. ":" .. id
	-- Pane metadata is presentation-only. Every operation pins the broker locator.
	local target = { destinationId = id, viewId = viewId, pane = info.pane, tab = info.tab, title = info.title, cwd = info.cwd, host = host.id }
	targets[viewId] = target
	return target, nil, "ready"
end

local function resolve(target, callback)
	-- Scheduling is not freshness: invalidate even while the request is in flight.
	resolved[target.viewId] = nil
	local active = resolving[target.viewId]
	if active then
		table.insert(active.callbacks, callback)
		return
	end
	-- One view handshake can validate several independently pinned file gestures.
	local request = { target = target, callbacks = { callback } }
	request.callback = function(view, err, cx)
		if request.finished then return end
		request.finished = true
		local callbacks = request.callbacks
		request.callbacks = nil
		for _, waiting in callbacks do waiting(view, err, cx) end
	end
	resolving[target.viewId] = request
	nextResolve[target.viewId] = tern.now() + 5000
	api("POST", "/v1/intents", { kind = "resolve", viewId = target.viewId, destinationId = target.destinationId }, function(receipt, err, cx)
		if resolving[target.viewId] ~= request then
			request.callback(nil, "OMP destination resolution was superseded; retry in the intended draft", cx)
			return
		end
		if err then resolving[target.viewId] = nil; request.callback(nil, err, cx); return end
		request.deadline = tern.now() + 10000
		pending[receipt.id] = request
	end)
end

local function pinDestination(cx, target)
	local view = state and state.connected and state.views[target.viewId]
	local confirmation = resolved[target.viewId]
	if not view or view.viewId ~= target.viewId or view.destinationId ~= target.destinationId
		or type(view.sessionId) ~= "string" or view.sessionId == ""
		or type(view.draftToken) ~= "string" or view.draftToken == ""
		or type(view.resolveIntentId) ~= "string" or view.resolveIntentId == ""
		or not connection or not confirmation or confirmation.resolveIntentId ~= view.resolveIntentId
		or tern.now() >= confirmation.validUntil then
		-- Do not start file work and adopt whichever draft resolves later.
		-- Resolve only to prepare a NEW user gesture; this one stays consumed.
		report(cx, "Original OMP destination is not resolved; wait for the bridge, then retry the transfer")
		if not resolving[target.viewId] then
			resolve(target, function(_, err, fresh) if err then report(fresh, err) end end)
		end
		return nil
	end
	-- Scalars only: polling and later handshakes must never mutate this identity.
	return table.freeze({ destinationId = target.destinationId, viewId = target.viewId,
		sessionId = view.sessionId, draftToken = view.draftToken, resolveIntentId = view.resolveIntentId })
end

-- Opening a chooser is preparation, not a file/clipboard capture gesture.
-- Refresh expired identity once, then open it without asking for a second click.
local preparingAction = false
local function prepareAction(cx, target, callback)
	local confirmation = resolved[target.viewId]
	if confirmation and tern.now() < confirmation.validUntil then callback(cx); return end
	if preparingAction then return end
	local prior = state and state.views[target.viewId]
	local sessionId, draftToken = prior and prior.sessionId, prior and prior.draftToken
	preparingAction = true
	resolve(target, function(view, err, fresh)
		preparingAction = false
		if err then report(fresh, err); return end
		if not fresh or not liveTarget(target) then report(fresh, "Original remote OMP destination is no longer available"); return end
		if prior and (view.sessionId ~= sessionId or view.draftToken ~= draftToken) then
			report(fresh, "Original OMP conversation or draft changed; open the action again in the intended draft")
			return
		end
		callback(fresh)
	end)
end

local function validateConversation(target, callback)
	resolve(target, function(view, err, cx)
		if err then callback(nil, err, cx); return end
		if not cx or not liveTarget(target) then
			callback(nil, "Original remote OMP pane is no longer available; retry in the intended draft", cx)
			return
		end
		if view.viewId ~= target.viewId or view.destinationId ~= target.destinationId or view.sessionId ~= target.sessionId then
			callback(nil, "Original OMP conversation changed; nothing was pasted or attached. Retry in the intended conversation", cx)
			return
		end
		-- Confirm the original conversation; attachment callers enforce their stricter draft policy.
		callback(view, nil, cx)
	end)
end

local function transfer(target, capture)
	validateConversation(target, function(view, err, cx)
		if err then release(capture.id); report(cx, err); return end
		if view.draftToken ~= target.draftToken then
			release(capture.id)
			report(cx, "Original OMP draft changed; no file was attached. Retry in the intended draft")
			return
		end
		api("POST", "/v1/transfers", { viewId = target.viewId, captureId = capture.id, expectedSessionId = target.sessionId, expectedDraftToken = target.draftToken, expectedResolveIntentId = view.resolveIntentId }, function(_, failure, fresh)
			if failure then release(capture.id); report(fresh, failure) end
		end)
	end)
end

local function deviceName(view, id)
	if id == nil or id == tern.json.null then return "Unbound" end
	for _, device in view.state.devices do if device.id == id then return device.name end end
	return "Unavailable device"
end

local function picker(cx, explicit)
	local target = explicit or destination(cx)
	if not target then cx:toast("info", "Focus a remote OMP pane to select its client"); return end
	target = pinDestination(cx, target)
	if not target then return end
	validateConversation(target, function(view, err, fresh)
		if err then report(fresh, err); return end
		local binding = view.state.binding
		local items = { { label = "Unbound", detail = "Agent-host operations only", clientId = tern.json.null, current = binding.clientId == nil } }
		for _, device in view.state.devices do
			local own = state and device.id == state.device.id
			table.insert(items, {
				label = device.name .. (own and " — This device" or ""),
				detail = device.platform .. " · " .. (device.online and "Online" or "Offline") .. " · Bind to use this computer under its native safety rules",
				clientId = device.id, current = binding.clientId == device.id,
			})
		end
		fresh:pick({ items = items, placeholder = "Agent client for this OMP session", action = "bind" }):next(function(item, pickError, current)
			if pickError then report(current, pickError); return end
			if not item then return end
			validateConversation(target, function(currentView, changed, currentCx)
				if changed then report(currentCx, changed); return end
				if currentView.draftToken ~= target.draftToken then report(currentCx, "Original OMP draft changed; select the device again"); return end
				api("POST", "/v1/intents", {
					kind = "bind", viewId = target.viewId, sessionId = target.sessionId, draftToken = target.draftToken,
					clientId = item.clientId, expectedRevision = binding.revision,
				}, function(receipt, failure, live)
					if failure then report(live, failure); return end
					operations[receipt.id] = { viewId = target.viewId, deadline = tern.now() + 65000 }
				end)
			end)
		end)
	end)
end

local function transfers(cx, target)
	if not state or #state.transfers == 0 then cx:toast("info", "No human transfers"); return end
	local items = {}
	for _, item in state.transfers do
		if not target or item.viewId == target.viewId then
			table.insert(items, { label = table.concat(item.names, ", "), detail = (transferPhaseLabels[item.phase] or item.phase) .. " · " .. tostring(item.bytesSent) .. "/" .. tostring(item.totalBytes) .. " bytes" .. (item.error and " · " .. item.error or ""), transfer = item })
		end
	end
	if #items == 0 then cx:toast("info", "No transfers for this OMP target"); return end
	cx:pick({ items = items, placeholder = "Human transfers — select to cancel", action = "cancel" }):next(function(item, err, fresh)
		if err then report(fresh, err); return end
		if not item then return end
		local phase = item.transfer.phase
		if phase == "attached" or phase == "failed" or phase == "cancelled" then return end
		api("POST", "/v1/transfers/cancel", { id = item.transfer.id }, function(_, failure, live)
			if failure then report(live, failure) end
		end)
	end)
end

local function interactions(cx, selected)
	if not selected and (not state or #state.interactions == 0) then cx:toast("info", "No pending device approvals"); return end
	local request = selected or state.interactions[1]
	if openApprovals[request.id] then return end
	openApprovals[request.id] = true
	local items = {}
	for _, choice in request.choices do table.insert(items, { label = choice.label, detail = request.message, choice = choice.id }) end
	table.insert(items, { label = "Reject", detail = request.message, choice = tern.json.null })
	cx:pick({ items = items, placeholder = request.title, action = "reply" }):next(function(item, err, fresh)
		openApprovals[request.id] = nil
		if err then report(fresh, err); return end
		local choice = item and item.choice or tern.json.null
		api("POST", "/v1/interactions/reply", { id = request.id, choice = choice }, function(_, failure, live)
			if failure then report(live, failure) end
		end)
	end)
end

local function pasteText(target, text, cx)
	-- Never allow clipboard bytes to terminate bracketed paste or become terminal
	-- controls. Preserve accepted text exactly; unsafe payloads need an encoded
	-- OMP insertion API rather than stripping bytes or executing shell input.
	local valid, unsafe = pcall(function()
		for _, code in utf8.codes(text) do
			if (code < 32 and code ~= 9 and code ~= 10 and code ~= 13) or (code >= 127 and code <= 159) then return true end
		end
		return false
	end)
	if not valid or unsafe then
		report(cx, "Clipboard text contains terminal control characters or invalid UTF-8; nothing was pasted")
		return
	end
	if text == "" then return end
	validateConversation(target, function(view, err, fresh)
		if err then report(fresh, err); return end
		if view.draftToken ~= target.draftToken then
			report(fresh, "Original OMP draft changed; nothing was pasted. Retry in the intended draft")
			return
		end
		api("POST", "/v1/intents", { kind = "paste", viewId = target.viewId, sessionId = target.sessionId,
			draftToken = target.draftToken, text = text }, function(receipt, failure, live)
			if failure then report(live, failure); return end
			operations[receipt.id] = { viewId = target.viewId, deadline = tern.now() + 65000 }
		end)
	end)
end

local function pasteClipboard(target)
	local request = { target = target }
	clipboardRequest = request
	api("POST", "/v1/captures/clipboard", { kind = "clipboard" }, function(capture, err, fresh)
		if clipboardRequest == request then clipboardRequest = nil end
		if err then if not request.cancelled then report(fresh, err) end; return end
		if request.cancelled then
			if capture.kind == "files" then release(capture.id) end
			return
		end
		if capture.kind == "files" then transfer(target, capture)
		elseif capture.kind == "text" and type(capture.text) == "string" then pasteText(target, capture.text, fresh)
		else report(fresh, "Invalid clipboard capture response") end
	end)
end

local function uploadFile(cx, target)
	api("POST", "/v1/captures/pick-file", { kind = "files" }, function(capture, err, fresh)
		filePickerOpen = false
		if err then report(fresh, err); return end
		if capture.cancelled then return end
		if not fresh or not liveTarget(target) then
			release(capture.id)
			report(fresh, "Original remote OMP pane is no longer available")
			return
		end
		transfer(target, capture)
	end)
end

local function pasteRemote(cx, explicit)
	if filePickerOpen or clipboardRequest then return end
	local target = explicit or destination(cx)
	if not target then cx:toast("info", "Focus a remote OMP pane to paste to remote"); return end
	target = pinDestination(cx, target)
	if not target then return end
	pasteClipboard(target)
end

local function uploadRemote(cx, explicit)
	if filePickerOpen or clipboardRequest then return end
	local target = explicit or destination(cx)
	if not target then cx:toast("info", "Focus a remote OMP pane to upload a file"); return end
	target = pinDestination(cx, target)
	if not target then return end
	filePickerOpen = true
	uploadFile(cx, target)
end

local function preparedAction(operation)
	return function(cx, explicit)
		local target = explicit or destination(cx)
		if not target then operation(cx, explicit); return end
		prepareAction(cx, target, function(fresh) operation(fresh, target) end)
	end
end
picker = preparedAction(picker)
pasteRemote = preparedAction(pasteRemote)
uploadRemote = preparedAction(uploadRemote)

local function publicText(value, fallback)
	if type(value) ~= "string" then return fallback or "" end
	local valid = pcall(function() for _ in utf8.codes(value) do end end)
	if not valid then return fallback or "" end
	value = value:gsub("%c", " ")
	if #value > 240 then
		local boundary = utf8.offset(value, 0, 241)
		value = value:sub(1, boundary - 1)
	end
	return value
end

local function publicCount(value)
	local number = tonumber(value)
	if not number or number ~= number or number == math.huge or number == -math.huge then return 0 end
	return math.floor(math.clamp(number, 0, 9007199254740991))
end

local setupController = nil
local setupLoading = false
local function setupModule(name, cx)
	local ok, module = pcall(require, name)
	if ok then return module end
	setupLoading = false
	report(cx, "Cannot load the Bridge setup module; reload the installed plugin package, then reopen setup")
	return nil
end
local function setupBridge(cx)
	if not cx then return end
	if clipboardRequest or filePickerOpen then cx:toast('info', 'Finish or cancel the current transfer before setup'); return end
	if setupController then setupController.open(cx); return end
	if setupLoading then return end
	setupLoading = true
	local origin = cx.sessions:current()
	-- Keep module IO/compilation out of the load hook and out of the UI turn.
	-- Preload the dependency separately, so requiring the controller is not a chain.
	tern.timer(0, function(fresh)
		if not setupModule('./setup-target', fresh) then return end
		tern.timer(0, function(current)
			local SetupController = setupModule('./setup-controller', current)
			if not SetupController then return end
			setupController = SetupController.new(tern, {
				owner = windowId,
				onState = function(value)
					setupBusy = value.pending ~= nil or value.launchQueued == true
					setupChecking = value.phase == 'checking'
					setupInfo = { status = value.phase, stage = value.stage, message = value.message, host = value.ssh }
				end,
				refresh = function() refreshChrome() end,
				onConnected = function()
					installationVerified, setupRequired = true, false
					if connection then return 'ready' end
					return connectionStatus == 'error' and 'error' or 'awaiting', connectionMessage
				end,
			})
			setupLoading = false
			tern.timer(0, function(fresh)
				if not fresh then return end
				local current = fresh.sessions:current()
				if current.id ~= origin.id or current.host ~= origin.host then
					fresh:toast('info', 'Bridge setup', 'The displayed session changed. Open Bridge again in the intended session.')
					return
				end
				setupController.open(fresh)
			end)
		end)
	end)
end

local function sameSnapshot(a, b)
	if type(a) ~= type(b) then return false end
	if type(a) ~= "table" then return a == b end
	for key, value in a do if not sameSnapshot(value, b[key]) then return false end end
	for key in b do if a[key] == nil then return false end end
	return true
end


local function hidePanel(cx)
	local owned = panel
	if not owned then return end
	panel = nil -- Revoke local routes before requesting the owned block's self-close.
	api("POST", "/v1/panels/close", { owner = windowId, panelId = owned.id }, function(_, err, fresh)
		if err then report(fresh, err) end
	end)
	refreshChrome()
end

local function publishPanel(cx)
	if not cx or not panel then return end
	if panel.creating or panel.publishing then return end
	for _, item in state and state.panels or {} do
		if item.owner == windowId and item.panelId == panel.id and item.phase == "closed" then
			panel = nil; refreshChrome(); return
		end
	end
	local target = panel.target
	local view = state and state.views[target.viewId]
	local available = liveTarget(target)
	local targetTitle = publicText(target.title, "Remote OMP")
	if targetTitle == "" then targetTitle = "Remote OMP" end
	local targetFolder = type(target.cwd) == "string" and target.cwd:match("([^/\\]+)[/\\]*$")
	if targetFolder then targetTitle ..= " · " .. publicText(targetFolder) end
	local snapshot = {
		owner = windowId, panelId = panel.id,
		source = publicText(state and state.device.name, "This device"),
		target = publicText(targetTitle .. (available and "" or " (closed)")),
		agent = publicText(view and deviceName(view, view.state.binding.clientId), "Resolving"),
		connected = available and state ~= nil and state.connected == true and statusError == nil,
		devices = tern.json.decode("[]"), transfers = tern.json.decode("[]"), approvals = state and #state.interactions or 0,
	}
	-- Never serialize raw errors: they can contain endpoint URLs or local paths.
	if statusError or not available then snapshot.error = "Bridge or original OMP target unavailable; see local status" end
	if view then
		for index, device in view.state.devices do
			if index > 32 then break end
			table.insert(snapshot.devices, { name = publicText(device.name), platform = publicText(device.platform), online = device.online == true, bound = device.id == view.state.binding.clientId })
		end
	end
	if state then
		for _, item in state.transfers do
			if item.viewId == target.viewId and #snapshot.transfers < 20 then
				table.insert(snapshot.transfers, {
					id = publicText(item.id), name = publicText(item.names and item.names[1], "Transfer"),
					phase = publicText(item.phase), bytesSent = publicCount(item.bytesSent),
					totalBytes = publicCount(item.totalBytes),
					error = item.error and "Transfer failed; open Transfers for details" or nil,
				})
			end
		end
	end
	if sameSnapshot(panel.snapshot, snapshot) and tern.now() < (panel.nextHeartbeat or 0) then return end
	local owned = panel
	owned.publishing = true
	api("POST", "/v1/panels/publish", { owner = windowId, panelId = owned.id,
		destinationId = target.destinationId, snapshot = snapshot }, function(_, err, fresh)
		owned.publishing = false
		if panel ~= owned then return end
		if err then panelError = "Bridge panel connection unavailable"; refreshChrome(); return end
		owned.snapshot, owned.nextHeartbeat = snapshot, tern.now() + 5000
		panelError = nil
	end)
end

-- The ordinal is read immediately before each command. The user accepts the
-- small current-tab check/dispatch race; native window identity remains pinned.
local function panelPipIndex(cx, owned)
	local layout = cx.session:layout(owned.target.tab)
	for index, item in layout and layout.floats or {} do
		if item.pane == owned.pane and item.over == owned.target.pane then return index end
	end
	return nil
end

local function stopPanelPip(cx, owned, auto)
	owned.pip = nil
	if auto.phase == "wait" then hidePanel(cx) end
end

local function runPanelPipCommand(owned, auto, verb, index)
	-- ctl reparses a command line: retain literal quotes so #N is not a comment.
	local argv = { owned.ternExecutable, "ctl", "pip", verb, '"#' .. tostring(index) .. '"' }
	if verb == "resize" then table.insert(argv, "240"); table.insert(argv, "360") end
	auto.phase = verb == "resize" and "glance-result" or "focus-result"
	auto.receipt = nil
	return pcall(tern.process.run, argv, { timeout_ms = 3000, env = { TERN_WINDOW_KEY = owned.nativeWindowKey, TERN_PANE_SOCKET = owned.ternPaneSocket } }, function(result)
		-- Receipt only: no native UI work or retained callback context here.
		if panel == owned and owned.pip == auto then auto.receipt = result end
	end)
end

local function panelPipStep(cx, owned)
	local auto = owned.pip
	if panel ~= owned or not auto or not cx then return end
	local session, info = cx.sessions:current(), cx.session:pane("@focused")
	if session.id ~= owned.session or session.host ~= owned.host or not info
		or info.tab ~= owned.target.tab
		or (info.pane ~= owned.target.pane and info.pane ~= owned.pane) then
		stopPanelPip(cx, owned, auto); return
	end
	if tern.now() > auto.deadline then
		stopPanelPip(cx, owned, auto)
		report(cx, "Bridge PiP initialization timed out; no automatic retry was started.")
		return
	end
	local panes, present, attached, created = cx.session:panes(), false, false, nil
	for _, candidate in panes do
		if candidate.pane == owned.target.pane and candidate.tab == owned.target.tab and not candidate.floating then present = true end
		if candidate.pane == owned.pane then created = candidate end
	end
	for _, host in cx.hosts:list() do
		if host.id == owned.host and host.kind == "remote" and host.state == "connected" then
			for _, pane in host.panes or {} do if pane == owned.target.pane then attached = true end end
		end
	end
	if not present or not attached then stopPanelPip(cx, owned, auto); return end
	-- A broker view cache may still be resolving. Read the actual original OMP.
	local ownerTree = cx.session:surface(owned.target.pane, { root = "dock", depth = 16, nodes = 512 })
	local ownerMarker = type(ownerTree) == "table" and type(ownerTree.surface) == "table"
		and ownerTree.surface.role == "omp.session" and roleNode(ownerTree.dock or ownerTree.main, "omp.client-bridge.destination")
	if not ownerMarker or ownerMarker.p.href ~= "omp-bridge-target://" .. owned.target.destinationId then
		stopPanelPip(cx, owned, auto); return
	end
	local function nextStep() tern.timer(16, function(fresh) return panelPipStep(fresh, owned) end) end
	if auto.phase == "wait" then
		if info.pane ~= owned.target.pane then stopPanelPip(cx, owned, auto); return end
		if not created then nextStep(); return end
		if created.floating then owned.pip = nil; return end
		if created.kind ~= "plugin" or created.block ~= panelKind then stopPanelPip(cx, owned, auto); return end
		-- Hidden tabs need not render a TSP surface. The returned pane ID identifies
		-- our new block; validate its surface nonce once it becomes visible as a PiP.
		local called, floated = pcall(function()
			return cx.layout:float(owned.pane, owned.target.pane, "tr", { focus = false })
		end)
		if not called or not floated then
			owned.pip = nil
			defer(function(fresh)
				if panel ~= owned then return end
				hidePanel(fresh)
				report(fresh, "Cannot place Bridge over its original OMP pane; closing this panel. Retry from the original OMP.")
			end)
			return
		end
		auto.phase = "glance"
		nextStep(); return
	end
	if not created or not created.floating then owned.pip = nil; return end
	if not panelSurface(cx, owned.pane) then nextStep(); return end
	if auto.phase == "glance" or auto.phase == "glance-result" then
		if info.pane ~= owned.target.pane then owned.pip = nil; return end
	end
	if auto.phase == "glance-result" or auto.phase == "focus-result" then
		local result = auto.receipt
		if not result then nextStep(); return end
		local decoded, reply = false, nil
		if type(result.stdout) == "string" and #result.stdout <= 4096 then decoded, reply = pcall(tern.json.decode, result.stdout) end
		if result.status ~= 0 or result.timed_out or not decoded or type(reply) ~= "table" or reply.ok ~= true then
			diagnostic("panel.pip.failed", { exitCode = result.status, timedOut = result.timed_out == true, resizing = auto.phase == "glance-result",
				jsonDecoded = decoded, nativeOk = decoded and type(reply) == "table" and reply.ok == true }, owned.operation)
			owned.pip = nil
			report(cx, "Tern could not initialize this Bridge PiP. Check the local Tern CLI and rerun install-tern --tern-pane-socket with the local daemon's absolute socket path; the command was not retried.")
			return
		end
		if auto.phase == "focus-result" then
			owned.pip = nil
			if info.pane == owned.pane then diagnostic("panel.pip.ready", { created = true }, owned.operation) end
			return
		end
		auto.receipt, auto.phase = nil, "focus"
	end
	if auto.phase == "focus" and info.pane == owned.pane then
		owned.pip = nil
		diagnostic("panel.pip.ready", { created = true }, owned.operation)
		return
	end
	local inspected, index = pcall(panelPipIndex, cx, owned)
	if not inspected then
		owned.pip = nil
		report(cx, "Cannot inspect the original tab's Bridge PiP; no native command was issued.")
		return
	end
	if not index then owned.pip = nil; return end
	local verb = auto.phase == "glance" and "resize" or "focus"
	if not runPanelPipCommand(owned, auto, verb, index) then
		owned.pip = nil
		report(cx, "Cannot start the configured local Tern executable. Repair Bridge setup or rerun install-tern --tern-executable with its current absolute path.")
		return
	end
	nextStep()
end

local function togglePanel(cx)
	local operation = diagnosticSerial
	diagnostic("target.inspect", { context = cx ~= nil })
	local current = cx.sessions:current()
	local target, reason, stage = destination(cx)
	diagnostic("target." .. (stage or (target and "ready" or "unavailable")), { target = target ~= nil, connected = state and state.connected == true, panel = panel ~= nil })
	if panel then
		local sameView = current.id == panel.session and current.host == panel.host
			and target and target.destinationId == panel.target.destinationId
		hidePanel(cx)
		if sameView then return end
	end
	if not target then
		-- An unsupported context is not a Bridge fault and must not poison other panes.
		cx:toast("info", "OMP Client Bridge", reason or "Use the Tern Bridge entry in the intended remote OMP session")
		return
	end
	if not state or not state.connected or not state.device then report(cx, "This device's Bridge connection is unavailable"); return end
	if not connection or not connection.ternExecutable then
		report(cx, "Missing or invalid local ternExecutable in Bridge config.json. On this device, rerun install-tern --tern-executable with the absolute Tern CLI path, then reload the plugin before opening Bridge PiP.")
		return
	end
	if not connection.ternPaneSocket then
		report(cx, "Missing or invalid local ternPaneSocket in Bridge config.json. On this device, rerun install-tern --tern-pane-socket with the absolute local Tern daemon socket path, then reload the plugin before opening Bridge PiP.")
		return
	end
	panelSerial += 1
	local owned = { id = "panel-" .. tostring(panelSerial), target = target, session = current.id, host = current.host, nativeWindowKey = cx:window_key(), ternExecutable = connection.ternExecutable, ternPaneSocket = connection.ternPaneSocket, creating = true, operation = operation }
	panel = owned
	local initial = { owner = windowId, panelId = owned.id, source = publicText(state.device.name, "This device"),
		target = publicText(target.title, "Remote OMP"), agent = "Resolving", connected = false, devices = tern.json.decode("[]"), transfers = tern.json.decode("[]"), approvals = 0 }
	diagnostic("panel.open.request", { context = current ~= nil })
	api("POST", "/v1/panels/open", { owner = windowId, panelId = owned.id, destinationId = target.destinationId, snapshot = initial }, function(_, err, fresh)
		diagnostic("panel.open.response", { failed = err ~= nil, context = fresh ~= nil }, operation)
		if panel ~= owned then
			api("POST", "/v1/panels/close", { owner = windowId, panelId = owned.id }, function() end)
			return
		end
		if err or not fresh then panel = nil; report(fresh, err or "Bridge window closed before the panel opened"); return end
		local session, focused = fresh.sessions:current(), destination(fresh)
		if session.id ~= owned.session or session.host ~= owned.host or not focused or focused.destinationId ~= target.destinationId then
			diagnostic("panel.target_changed", { sessionMatch = session.id == owned.session, hostMatch = session.host == owned.host, destinationMatch = focused ~= nil and focused.destinationId == target.destinationId }, operation)
			hidePanel(fresh); report(fresh, "The displayed OMP target changed before Bridge opened; retry in the intended session"); return
		end
		local ok, pane = pcall(function() return fresh:new_block(panelKind, { windowId, owned.id, state.device.id }, "tab", { focus = false }) end)
		diagnostic("panel.block.result", { created = ok and pane ~= nil and pane ~= false, exception = not ok }, operation)
		if not ok or not pane then hidePanel(fresh); report(fresh, "Install or reload the Bridge host plugin on the intended host"); return end
		owned.pane, owned.creating = pane, false
		diagnostic("panel.opened", { created = true }, operation)
		panelError = nil
		publishPanel(fresh)
		refreshChrome()
		owned.pip = { phase = "wait", deadline = tern.now() + 10000 }
		tern.timer(16, function(current) return panelPipStep(current, owned) end)
	end)
end

-- Aggregate during polling, not inside the 4 ms chrome formatter.
local function updateTransferSummary(value, online)
	local active, uploading, ready, failed, completed = 0, 0, 0, 0, 0
	local sent, total, known = 0, 0, true
	local phases = {}
	for _, item in (value and value.transfers or {}) do
		phases[item.id] = item.phase
		if item.phase == "attached" then
			if transferPhases[item.id] and transferPhases[item.id] ~= "attached" then completed += 1 end
		elseif item.phase == "failed" then failed += 1
		elseif item.phase ~= "cancelled" then
			active += 1
			if item.phase == "uploading" then
				uploading += 1
				local size = publicCount(item.totalBytes)
				if size == 0 then known = false end
				total += size
				sent += math.min(publicCount(item.bytesSent), size)
			elseif item.phase == "ready" then ready += 1 end
		end
	end
	transferPhases = phases
	local now = tern.now()
	if completed > 0 then
		transferDoneCount = (now < transferDoneUntil and transferDoneCount or 0) + completed
		transferDoneUntil = now + 5000
	end
	local summary = { failed = failed, icon = "upload", tone = "accent" }
	if active > 0 then
		if not online then summary.text, summary.tone = "Status unavailable", "warn"
		elseif uploading > 0 then
			summary.text = "Uploading" .. (known and total > 0 and (" " .. tostring(math.floor(sent / total * 100)) .. "%") or "")
		elseif ready > 0 then summary.text = "Handing to OMP"
		else summary.text = "Preparing" end
		if active > 1 then summary.text ..= " · " .. tostring(active) .. " transfers" end
	elseif now < transferDoneUntil then
		summary.text = "Handed to OMP" .. (transferDoneCount > 1 and (" · " .. tostring(transferDoneCount)) or "")
		summary.icon, summary.tone = "check", "ok"
	end
	transferSummary = summary
end

local function expirePending(cx)
	for id, request in pending do
		if tern.now() > request.deadline then
			pending[id] = nil
			if resolving[request.target.viewId] == request then
				resolving[request.target.viewId] = nil
				resolved[request.target.viewId] = nil
			end
			request.callback(nil, "OMP bridge handshake timed out; check that its extension is loaded", cx)
		end
	end
end

local function poll(cx)
	if pollBusy then return end
	if not connection then
		expirePending(cx)
		local advanced = loadConnection()
		refreshChrome()
		tern.timer(advanced and 0 or 3000, poll)
		return
	end
	pollBusy = true
	api("GET", "/v1/state", nil, function(value, err, fresh)
		pollBusy = false
		if err then
			statusError = err
			connection, connectionConfig = nil, nil
			connectionStatus, connectionMessage = "error", "Local Bridge request failed; check this device's Bridge service and retry"
			resolved = {}
			resolving = {}
		else
			state = value
			statusError = nil
			if not state.connected then resolved = {}; resolving = {} end
			for _, outcome in state.outcomes or {} do
				local operation = operations[outcome.id]
				if operation and outcome.viewId == operation.viewId then
					operations[outcome.id] = nil
					if outcome.error then report(fresh, outcome.error) end
				end
				local request = pending[outcome.id]
				if request and outcome.error and outcome.viewId == request.target.viewId then
					pending[outcome.id] = nil
					if resolving[request.target.viewId] == request then resolving[request.target.viewId] = nil end
					request.callback(nil, outcome.error, fresh)
				end
			end
			for id, operation in operations do
				if tern.now() >= operation.deadline then
					operations[id] = nil
					report(fresh, "Bridge operation completion was not confirmed; inspect the original draft before retrying. Nothing was replayed.")
				end
			end
			if clipboardRequest and not clipboardRequest.cancelled and not liveTarget(clipboardRequest.target) then
				clipboardRequest.cancelled = true
			end
			for id, request in pending do
				local view = state.views[request.target.viewId]
				if resolving[request.target.viewId] ~= request then
					pending[id] = nil
					request.callback(nil, "OMP destination resolution was superseded; retry in the intended draft", fresh)
				elseif view and view.resolveIntentId == id then
					pending[id] = nil
					resolving[request.target.viewId] = nil
					-- Only an observed matching successful receipt grants gesture eligibility.
					resolved[request.target.viewId] = { resolveIntentId = id, validUntil = tern.now() + 5000 }
					request.callback(view, nil, fresh)
				end
			end
			-- Resolve native conversation identity outside chrome, including /new in
			-- the same pane. This does not bind a device or capture any clipboard.
			defer(function(current)
				if not current then return end
				local target = destination(current)
				if target and tern.now() >= (nextResolve[target.viewId] or 0) then
					if not resolving[target.viewId] then resolve(target, function(_, failure, live) if failure then report(live, failure) end end) end
				end
			end)
		end
		-- Expiry also runs while disconnected, so captures cannot wait forever.
		expirePending(fresh)
		updateTransferSummary(state, not err and state and state.connected == true)
		defer(publishPanel)
		refreshChrome()
		tern.timer(err and 3000 or 500, poll)
	end)
end

tern.command({ id = "setup", title = "Set up Bridge", icon = "plug", group = "OMP", run = setupBridge })
tern.command({ id = "toggle-bridge", title = "Toggle Bridge", icon = "panel-right", group = "OMP", run = function(cx)
	diagnosticSerial += 1
	diagnostic("entry.command", { context = cx ~= nil, connected = state and state.connected == true })
	if setupBusy or setupRequired or (not connection and connectionStatus == "awaiting") then
		setupBridge(cx)
	else
		if not connection and connectionStatus == "error" then cx:toast("error", "OMP Client Bridge", connectionMessage); return end
		if setupController then setupController.hide(cx) end
		togglePanel(cx)
	end
end })
local function handlePanelLink(req, cx)
	-- All links in our scheme are consumed, including malformed, foreign and stale
	-- links. Never let a rejected action fall through to a system URL handler.
	local owner, id, verb = req.url:match("^omp%-bridge%-panel://([%w_.%-]+)/([%w_.%-]+)/([a-z]+)$")
	if not panel or owner ~= windowId or id ~= panel.id or req.pane ~= panel.pane
		or cx.session:focused() ~= req.pane or not panelSurface(cx) then
		cx:toast("error", "OMP Client Bridge", "This Bridge panel is stale or belongs to another window; open Toggle Bridge in this window")
		return { handled = true }
	end
	if verb == "hide" then hidePanel(cx); return { handled = true } end
	local target = destination(cx, panel.target)
	if not target then report(cx, "Original remote OMP pane is no longer available"); return { handled = true } end
	if verb == "paste" then pasteRemote(cx, target)
	elseif verb == "upload" then uploadRemote(cx, target)
	elseif verb == "devices" then picker(cx, target)
	elseif verb == "transfers" then transfers(cx, target)
	elseif verb == "approvals" then interactions(cx)
	else cx:toast("error", "OMP Client Bridge", "Unknown Bridge panel action") end
end
tern.route.link(function(req, cx)
	if type(req.url) == "string" and req.url:sub(1, #"omp-bridge-panel:") == "omp-bridge-panel:" then
		-- Claim private URLs before any surface inspection, HTTP or native picker.
		-- A slow chooser must never time out route.link and fall through to macOS.
		local captured = { url = req.url, pane = req.pane }
		defer(function(fresh) if fresh then handlePanelLink(captured, fresh) end end)
		return { handled = true }
	end
	return setupController and setupController.route(req, cx) or nil
end)
tern.command({ id = "devices", title = "Select agent device", group = "OMP", run = picker })
tern.command({ id = "transfers", title = "Human transfers", group = "OMP", run = transfers })
tern.command({ id = "approvals", title = "Pending client approvals", group = "OMP", run = interactions })
tern.command({ id = "paste-remote", title = "Paste to remote", icon = "clipboard", group = "OMP", run = function(cx)
	if setupRequired then setupBridge(cx) else pasteRemote(cx) end
end })
tern.command({ id = "upload-file", title = "Upload file", icon = "file-plus", group = "OMP", run = function(cx)
	if setupRequired then setupBridge(cx) else uploadRemote(cx) end
end })
-- Native paste remains untouched: no clipboard classification, delay, or replay.
tern.route.open(function(req, cx)
	if req.origin ~= "drop" then return nil end
	local localFile = false
	for _, host in cx.hosts:list() do
		if host.kind == "local" and (req.host == host.name or req.host == "local") then localFile = true end
	end
	if not localFile then return nil end
	-- OpenRequest has no hovered destination id in Tern 0.8.3. The native
	-- routing probe must verify that Tern focuses the destination before this
	-- callback; otherwise the host needs an explicit destination-pane field.
	local target = destination(cx)
	if not target then return nil end
	target = pinDestination(cx, target)
	if not target then return { handled = true } end
	api("POST", "/v1/captures", { kind = "files", paths = { req.path } }, function(capture, err, fresh)
		if err then report(fresh, err); return end
		transfer(target, capture)
	end)
	return { handled = true }
end)

local function statusSegments(viewId)
	if setupChecking then
		return { { text = setupInfo and setupInfo.stage or "Checking SSH", icon = "clock", tone = "accent", command = action .. "setup" } }
	end
	if setupBusy then
		return { { text = "Setting up · " .. publicText(setupInfo and setupInfo.stage, "Starting"), icon = "clock", tone = "accent", command = action .. "setup" } }
	end
	if setupRequired then
		return { { text = "Set up Bridge", icon = "plug", tone = "warn", command = action .. "setup" } }
	end
	if not connection then
		local fault = connectionStatus == "error"
		return { { text = fault and "Bridge endpoint needs attention" or "Waiting for local Bridge", icon = "plug", tone = fault and "error" or "warn", command = action .. "toggle-bridge" } }
	end
	local failed, approvals = transferSummary.failed, state and #state.interactions or 0
	local unavailable = statusError ~= nil or panelError ~= nil
	local connected = state and state.connected == true
	local view = state and state.views[viewId]
	if setupInfo and setupInfo.status == "awaiting_session" and not view and not unavailable then
		local label = setupInfo.stage == "awaiting-host-plugin" and "Reload host plugin"
			or setupInfo.stage == "awaiting-service-upgrade" and "Service update required"
			or "Open remote OMP · load extension"
		return { { text = label, icon = "terminal", tone = "warn", command = action .. "toggle-bridge" } }
	end
	local text, icon, tone = "Disconnected", "plug", "warn"
	if connected then
		text, tone = viewId and targets[viewId] and "Connected · Resolving" or "Connected · No session", "muted"
		if view then
			local bound = view.state.binding.clientId
			if bound == nil or bound == tern.json.null then
				text = "Connected · Unbound"
			else
				local device = nil
				for _, candidate in view.state.devices do
					if candidate.id == bound then device = candidate; break end
				end
				local name = publicText(device and device.name, "Unavailable device")
				local cut = utf8.offset(name, 25)
				if cut then name = name:sub(1, cut - 1) .. "…" end
				text = (device and device.online and "Connected · " or "Device offline · ") .. name
				icon, tone = "monitor", device and device.online and "muted" or "warn"
			end
		end
	end
	if unavailable then text, icon, tone = "Needs attention", "warn", "error" end
	local segments = {
		{ text = text, icon = icon, tone = tone == "muted" and panel and "accent" or tone,
			command = action .. "toggle-bridge" },
	}
	if transferSummary.text then table.insert(segments, { text = transferSummary.text, icon = transferSummary.icon, tone = transferSummary.tone, command = action .. "transfers" }) end
	if failed > 0 then table.insert(segments, { text = tostring(failed) .. " failed", icon = "warn", tone = "error", command = action .. "transfers" }) end
	if approvals > 0 then table.insert(segments, { text = tostring(approvals) .. " pending", icon = "shield", tone = "warn", command = action .. "approvals" }) end
	return segments
end

local chromeQueued = false
refreshChrome = function()
	if chromeQueued then return end
	chromeQueued = true
	defer(function()
		chromeQueued = false
		defaultStatus = statusSegments(nil)
		local cache = {}
		for viewId, target in targets do if target.pane then cache[target.pane] = statusSegments(viewId) end end
		statusByPane = cache
		tern.chrome.refresh()
	end)
end
tern.chrome.status(function(info)
	-- Only cached lookups under Tern's 4 ms formatter budget.
	local pane = panel and info.pane == panel.pane and panel.target.pane or info.pane
	return statusByPane[pane] or defaultStatus
end)

tern.on("focus", function(_, cx)
	local target = destination(cx)
	-- Merely focusing our display must not invalidate an already-confirmed draft
	-- immediately before its click arrives. Expiry still triggers normal refresh.
	if panel and panelSurface(cx) and target then
		local confirmed = resolved[target.viewId]
		if confirmed and tern.now() < confirmed.validUntil then return end
	end
	if target and connection then resolve(target, function(_, err, fresh) if err then report(fresh, err) end end) end
end)
tern.on('command_finished', function(ev) if setupController then setupController.commandFinished(ev) end end)
tern.on("pane_closed", function(ev, cx)
	if setupController then setupController.closed(ev.pane) end
	-- Truncated window pane IDs are not destination identities. The broker revokes
	-- the exact draft channel on OMP closure; host panel receipts report UI closure.
	if panel then publishPanel(cx) end
end)
diagnostic("loaded")
tern.timer(0, poll)
