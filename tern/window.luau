-- SPDX-License-Identifier: MPL-2.0
-- Only local window input handlers capture human data. No Carly exports.
local windowId = string.format("%x-%x-%x", math.floor(tern.now() * 1000), math.random(0, 2147483647), math.random(0, 2147483647))
local state = nil
local connection = nil
local statusError = nil
local panes = {}
local delivered = {}
local pending = {}
local nextResolve = {}
local resolving = {}
local resolved = {}
local pollBusy = false
local action = "plugin.omp-client-bridge."

local function report(cx, message)
	statusError = tostring(message)
	tern.chrome.refresh()
	if cx then cx:toast("error", "OMP Client Bridge", statusError) end
end

local function loadConnection()
	local config = tern.json.decode(tern.fs.read(tern.plugin.data .. "/config.json", 16384))
	local endpoint = tern.json.decode(tern.fs.read(config.controlFile, 16384))
	-- Never disclose the local bearer to a remote URL or to the agent host.
	if type(endpoint.url) ~= "string" or not endpoint.url:match("^http://127%.0%.0%.1:%d+/?$") then
		error("Client UI endpoint must be http://127.0.0.1:PORT")
	end
	if type(endpoint.token) ~= "string" or endpoint.token == "" then error("Missing local UI token") end
	connection = { url = endpoint.url:gsub("/$", ""), token = endpoint.token }
end

local function api(method, path, body, callback)
	if not connection then
		local ok, err = pcall(loadConnection)
		if not ok then callback(nil, tostring(err), nil); return end
	end
	local options = {
		method = method,
		headers = { Authorization = "Bearer " .. connection.token, ["Content-Type"] = "application/json" },
		timeout_ms = 10000,
	}
	if body then options.body = tern.json.encode(body) end
	tern.fetch(connection.url .. path, options, function(response, cx)
		if response.error then callback(nil, response.error, cx); return end
		local ok, value = pcall(tern.json.decode, response.body)
		if not ok then callback(nil, "Invalid local UI response", cx); return end
		if response.status < 200 or response.status >= 300 then
			callback(nil, type(value.error) == "string" and value.error or "Local UI request failed (" .. tostring(response.status) .. ")", cx)
			return
		end
		callback(value, nil, cx)
	end)
end

local function release(id)
	api("POST", "/v1/captures/release", { id = id }, function(_, err, cx)
		if err then report(cx, err) end
	end)
end

local function remoteOmp(cx, pane)
	if not pane then return false end
	local remote = false
	for _, host in cx.hosts:list() do
		if host.kind == "remote" and host.state == "connected" then
			for _, id in host.panes do if id == pane then remote = true; break end end
		end
	end
	if not remote then return false end
	for _, info in cx.session:panes() do
		if info.pane == pane then
			-- Native OMP retains its launching shell's program/prompt metadata.
			if info.kind ~= "agent" or info.exited ~= nil then return false end
			local tree = cx.session:surface(pane, { depth = 0, nodes = 1 })
			return type(tree) == "table" and type(tree.surface) == "table" and tree.surface.role == "omp.session"
		end
	end
	return false
end

local function destination(cx)
	local pane = cx.session:focused()
	if not remoteOmp(cx, pane) then return nil end
	local viewId = windowId .. ":" .. string.format("%.0f", pane)
	panes[viewId] = pane
	return { pane = pane, viewId = viewId }
end

local function send(cx, target, frame)
	if not cx or not remoteOmp(cx, target.pane) then return false, "Original remote OMP pane is no longer available" end
	local ok, err = pcall(function() cx:run(target.pane, frame) end)
	return ok, err
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
	api("POST", "/v1/intents", { kind = "resolve", viewId = target.viewId }, function(receipt, err, cx)
		if resolving[target.viewId] ~= request then
			request.callback(nil, "OMP destination resolution was superseded; retry in the intended draft", cx)
			return
		end
		if err then resolving[target.viewId] = nil; request.callback(nil, err, cx); return end
		local ok, failure = send(cx, target, receipt.frame)
		if not ok then resolving[target.viewId] = nil; request.callback(nil, failure, cx); return end
		request.deadline = tern.now() + 10000
		pending[receipt.id] = request
	end)
end

local function pinDestination(cx, target)
	local view = state and state.connected and state.views[target.viewId]
	local confirmation = resolved[target.viewId]
	if not view or view.viewId ~= target.viewId
		or type(view.sessionId) ~= "string" or view.sessionId == ""
		or type(view.draftToken) ~= "string" or view.draftToken == ""
		or type(view.resolveIntentId) ~= "string" or view.resolveIntentId == ""
		or not connection or not confirmation or confirmation.resolveIntentId ~= view.resolveIntentId
		or tern.now() >= confirmation.validUntil then
		-- Do not start file work and adopt whichever draft resolves later.
		-- Resolve only to prepare a NEW user gesture; this one stays consumed.
		report(cx, "Original OMP destination is not resolved; wait for the bridge, then retry drop")
		if not resolving[target.viewId] then
			resolve(target, function(_, err, fresh) if err then report(fresh, err) end end)
		end
		return nil
	end
	-- Scalars only: polling and later handshakes must never mutate this identity.
	return table.freeze({ pane = target.pane, viewId = target.viewId,
		sessionId = view.sessionId, draftToken = view.draftToken, resolveIntentId = view.resolveIntentId })
end

local function validateConversation(target, callback)
	resolve(target, function(view, err, cx)
		if err then callback(nil, err, cx); return end
		if not cx or panes[target.viewId] ~= target.pane or not remoteOmp(cx, target.pane) then
			callback(nil, "Original remote OMP pane is no longer available; retry in the intended draft", cx)
			return
		end
		if view.viewId ~= target.viewId or view.sessionId ~= target.sessionId then
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

local function picker(cx)
	local target = destination(cx)
	if not target then cx:toast("info", "Focus a remote OMP pane to select its client"); return end
	resolve(target, function(view, err, fresh)
		if err then report(fresh, err); return end
		local binding = view.state.binding
		local items = { { label = "Unbound", detail = "Agent-host operations only", clientId = tern.json.null, current = binding.clientId == nil } }
		for _, device in view.state.devices do
			local own = state and device.id == state.device.id
			table.insert(items, {
				label = device.name .. (own and " — This device" or ""),
				detail = device.platform .. " · " .. (device.online and "Online" or "Offline") .. " · " .. table.concat(device.capabilities, ", "),
				clientId = device.id, current = binding.clientId == device.id,
			})
		end
		fresh:pick({ items = items, placeholder = "Agent client for this OMP session", action = "bind" }):next(function(item, pickError, current)
			if pickError then report(current, pickError); return end
			if not item then return end
			api("POST", "/v1/intents", {
				kind = "bind", viewId = target.viewId, sessionId = view.sessionId,
				clientId = item.clientId, expectedRevision = binding.revision,
			}, function(receipt, failure, live)
				if failure then report(live, failure); return end
				local ok, sendError = send(live, target, receipt.frame)
				if not ok then report(live, sendError) end
			end)
		end)
	end)
end

local function transfers(cx)
	if not state or #state.transfers == 0 then cx:toast("info", "No human transfers"); return end
	local items = {}
	for _, item in state.transfers do
		table.insert(items, { label = table.concat(item.names, ", "), detail = item.phase .. " · " .. tostring(item.bytesSent) .. "/" .. tostring(item.totalBytes) .. " bytes" .. (item.error and " · " .. item.error or ""), transfer = item })
	end
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

local function interactions(cx)
	if not state or #state.interactions == 0 then cx:toast("info", "No pending device approvals"); return end
	local request = state.interactions[1]
	local items = {}
	for _, choice in request.choices do table.insert(items, { label = choice.label, choice = choice.id }) end
	table.insert(items, { label = "Reject", choice = tern.json.null })
	cx:toast("info", request.title, request.message)
	cx:pick({ items = items, placeholder = request.title, action = "reply" }):next(function(item, err, fresh)
		if err then report(fresh, err); return end
		api("POST", "/v1/interactions/reply", { id = request.id, choice = item and item.choice or tern.json.null }, function(_, failure, live)
			if failure then report(live, failure) end
		end)
	end)
end

local function poll(cx)
	if pollBusy then return end
	pollBusy = true
	api("GET", "/v1/state", nil, function(value, err, fresh)
		pollBusy = false
		if err then
			statusError = err
			connection = nil
			resolved = {}
			resolving = {}
		else
			state = value
			statusError = nil
			if not state.connected then resolved = {}; resolving = {} end
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
			for _, item in state.transfers do
				local pane = panes[item.viewId]
				if pane and item.phase == "ready" and item.frame and not delivered[item.id] then
					delivered[item.id] = true -- no side-effect replay after an uncertain send
					local ok, failure = send(fresh, { pane = pane }, item.frame)
					if not ok then
						report(fresh, failure)
						api("POST", "/v1/transfers/cancel", { id = item.id }, function(_, cancelError, live)
							if cancelError then report(live, cancelError) end
						end)
					end
				end
			end
			-- Resolve native conversation identity outside chrome, including /new in
			-- the same pane. This does not bind a device or capture any clipboard.
			if fresh then
				local target = destination(fresh)
				if target and tern.now() >= (nextResolve[target.viewId] or 0) then
					if not resolving[target.viewId] then resolve(target, function(_, failure, live) if failure then report(live, failure) end end) end
				end
			end
		end
		-- Expiry also runs while disconnected, so captures cannot wait forever.
		for id, request in pending do
			if tern.now() > request.deadline then
				pending[id] = nil
				if resolving[request.target.viewId] == request then
					resolving[request.target.viewId] = nil
					resolved[request.target.viewId] = nil
				end
				request.callback(nil, "OMP bridge handshake timed out; check that its extension is loaded", fresh)
			end
		end
		tern.chrome.refresh()
		tern.timer(err and 3000 or 500, poll)
	end)
end

tern.command({ id = "devices", title = "OMP: Select agent client", run = picker })
tern.command({ id = "transfers", title = "OMP: Human transfer progress / cancel", run = transfers })
tern.command({ id = "approvals", title = "OMP: Pending client approvals", run = interactions })
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

tern.chrome.status(function(info)
	-- Pure cached table access: no filesystem, network, clipboard, or cx here.
	local segments = { { text = "This device: " .. (state and state.device.name or "not connected"), command = action .. "devices" } }
	if statusError then
		table.insert(segments, { text = "Bridge unavailable", tone = "error", command = action .. "devices" })
	else
		local viewId = windowId .. ":" .. string.format("%.0f", info.pane)
		local view = state and state.views[viewId]
		local text = "Agent client: resolve…"
		local tone = "muted"
		if view then
			text = "Agent client: " .. deviceName(view, view.state.binding.clientId)
			for _, device in view.state.devices do
				if device.id == view.state.binding.clientId then text ..= device.online and " · Online" or " · Offline"; tone = device.online and "ok" or "warn" end
			end
			local change = view.state.binding.change
			if change then text ..= " · " .. change.actor.name .. ": " .. deviceName(view, change.previousClientId) .. " → " .. deviceName(view, change.clientId) end
		end
		if state and not state.connected then text ..= " · Relay offline"; tone = "warn" end
		table.insert(segments, { text = text, tone = tone, command = action .. "devices" })
	end
	if state then
		for _, item in state.transfers do
			if panes[item.viewId] == info.pane then
				table.insert(segments, { text = "Transfer: " .. item.phase .. " " .. tostring(item.bytesSent) .. "/" .. tostring(item.totalBytes), tone = item.phase == "failed" and "error" or "muted", command = action .. "transfers" })
			end
		end
		if #state.interactions > 0 then table.insert(segments, { text = tostring(#state.interactions) .. " client approvals", tone = "warn", command = action .. "approvals" }) end
	end
	return segments
end)

tern.on("focus", function(_, cx)
	local target = destination(cx)
	if target and connection then resolve(target, function(_, err, fresh) if err then report(fresh, err) end end) end
end)
tern.on("pane_closed", function(ev, _)
	for viewId, pane in panes do
		if pane == ev.pane then
			panes[viewId] = nil
			resolved[viewId] = nil
			resolving[viewId] = nil
			if state then
				for _, item in state.transfers do
					if item.viewId == viewId and (item.phase == "captured" or item.phase == "uploading" or item.phase == "ready") then
						api("POST", "/v1/transfers/cancel", { id = item.id }, function(_, err, fresh) if err then report(fresh, err) end end)
					end
				end
			end
		end
	end
end)
tern.timer(0, poll)
