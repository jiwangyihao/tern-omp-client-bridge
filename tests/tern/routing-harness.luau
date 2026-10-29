-- SPDX-License-Identifier: MPL-2.0
-- Synthetic SDK boundary executing the actual shipped window.luau in Luau.
-- This is NOT native Tern, physical clipboard, editor, transport, or platform acceptance.
-- The fixture controls async receipts and fresh callback contexts, never copies the router.
function run(entry, loadModule)
	local passed = 0
	local function fixture()
		local handlers, timers, requests, encoded = {}, {}, {}, {}
		local deferred, inReceipt = {}, false
		local deferredDelays, callbackDelay = {}, nil
		local original, other = 17592186044423, 17592186044424
		local focused, remote, clock = original, true, 1
		local opened = { [original] = true, [other] = true }
		local serial, ioCount = 0, 0
		local null = {}
		local decodedState = nil
		local surfaceRole, paneKind = "omp.session", "agent"
		local f = { original = original, other = other, sent = {}, native = {}, errors = {}, toasts = {}, commands = {} }
		f.picks, f.prompts = {}, {}
		f.creations, f.resizes, f.closes, f.snapshots = {}, {}, {}, {}
		f.actions, f.floats = {}, {}
		f.processes = {}
		f.windowKey, f.processReceipts = "fixture-window", {}
		function f.nativePaneSocket()
			return f.daemonSocket or (tern.runtime.os == "windows" and "C:\\Users\\Fixture\\Tern\\daemon.sock" or "/isolated/Tern Data/daemon.sock")
		end
		function f.nativeConfig()
			return { controlFile = "/isolated/client.json", ternExecutable = tern.runtime.os == "windows" and "C:\\Program Files\\Tern\\tern.exe" or "/isolated/Tern CLI/tern", ternPaneSocket = f.nativePaneSocket() }
		end
		f.writes = {}
		f.logs = {}
		f.moduleLoads, f.reads, f.setupOpens = {}, {}, 0
		f.surfaceChecks = 0
		local blocks, foreignHosts = {}, {}
		local nextPane = other + 1
		local layout = { tab = 1, root = { split = "right", ratio = 0.5, { pane = original }, { pane = other } }, floats = {}, zoomed = false, focus = original }
		local tabs, paneTabs, nextTab = { [1] = layout }, { [original] = 1, [other] = 1 }, 1
		local function floatingPane(tab, pane)
			for index, floating in tab.floats do
				if floating.pane == pane then return floating, index end
			end
			return nil
		end
		local function replaceLeaf(node, pane, replacement)
			if not node then return nil end
			if node.pane == pane then return replacement end
			if node.split then
				node[1] = replaceLeaf(node[1], pane, replacement)
				node[2] = replaceLeaf(node[2], pane, replacement)
				if not node[1] then return node[2] end
				if not node[2] then return node[1] end
			end
			return node
		end
		local function detachPane(pane)
			local tabId = paneTabs[pane]
			local tab = tabs[tabId]
			if not tab then return end
			tab.root = replaceLeaf(tab.root, pane, nil)
			local _, index = floatingPane(tab, pane)
			if index then table.remove(tab.floats, index) end
			if not tab.root and #tab.floats == 0 then tabs[tabId] = nil end
			paneTabs[pane] = nil
		end
		local function removePane(pane)
			local owner = blocks[pane] and blocks[pane].owner
			detachPane(pane)
			opened[pane], blocks[pane] = nil, nil
			if focused == pane then focused = owner and opened[owner] and owner or other end
		end
		local ui = { device = { id = "self", name = "Fixture client" }, connected = true, views = {}, transfers = {}, interactions = {}, panels = {} }
		local destinations = { [original] = "destination-A", [other] = "destination-B" }
		local revoked = {}
		local function copy(value)
			if type(value) ~= "table" or value == null then return value end
			local result = {}
			for key, item in value do result[key] = copy(item) end
			return result
		end
		local originalRoot = copy(layout.root)
		local function sameTree(a, b)
			if type(a) ~= type(b) then return false end
			if type(a) ~= "table" then return a == b end
			for key, value in a do if not sameTree(value, b[key]) then return false end end
			for key in b do if a[key] == nil then return false end end
			return true
		end
		local function encode(value)
			serial += 1
			local token = "json:" .. tostring(serial)
			encoded[token] = copy(value)
			return token
		end
		local function context()
			local alive = true
			local function live() assert(alive, "expired callback context was reused") end
			local cx = {
				window_key = function() live(); return f.windowKey end,
				sessions = { current = function() live(); return { id = f.currentSession or 1, host = f.currentHost or 2 } end },
				session = {
					focused = function() live(); return focused end,
					panes = function()
						live()
						local panes = {}
						for pane in opened do
							local tabId = paneTabs[pane]
							table.insert(panes, { pane = pane, program = "zsh", tab = tabId, floating = floatingPane(tabs[tabId], pane) ~= nil, kind = blocks[pane] and "plugin" or paneKind, block = blocks[pane] and blocks[pane].block, at_prompt = true })
						end
						return panes
					end,
					pane = function(_, spec)
						live(); assert(spec == "@focused", "numeric pane lookup must not be used")
						if not opened[focused] then return nil end
						local tabId = paneTabs[focused]
						return { pane = focused, tab = tabId, floating = floatingPane(tabs[tabId], focused) ~= nil, kind = blocks[focused] and "plugin" or paneKind, title = f.paneTitle or "Remote OMP", cwd = f.paneCwd or "/fixture" }
					end,
					surface = function(_, spec)
						live()
						local pane = spec == "@focused" and focused or spec
						f.surfaceChecks += 1
						if not opened[pane] or f.nativeSurfaceMissing == pane then return nil end
						if f.hiddenPanelSurfaceMissing and blocks[pane] and paneTabs[pane] ~= 1 then return nil end
						if blocks[pane] or f.panelSurfaceAlias == pane then
							local args = blocks[f.panelSurfaceAlias == pane and f.panelPane or pane].args
							return { surface = { role = "plugin.omp-client-bridge.panel" }, main = { c = { { p = { role = "omp.client-bridge.panel-owner", text = f.panelSurfaceOwner or (args[1] .. "/" .. args[2]) } } } } }
						end
						local node = { p = { role = "omp.client-bridge.destination", href = "omp-bridge-target://" .. (f.destinationOverride and f.destinationOverride[pane] or destinations[pane]) } }
						return { surface = { id = "s:fixture", mode = "inline", role = surfaceRole }, dock = { c = f.noWidget and {} or { node } } }
					end,
					layout = function(_, tabId)
						live()
						assert(tabId == paneTabs[original], "PiP ordinal lookup escaped its original tab")
						if f.layoutError then error("native layout unavailable") end
						local result = copy(tabs[tabId])
						if f.missingFloat then result.floats = {} end
						return result
					end,
					event = function() error("numeric pane event must not be used") end,
				},
				hosts = { list = function()
					live()
					if f.hostListError then error("host API unavailable") end
					if f.setupHosts then return f.setupHosts end
					local panes, foreign = {}, {}
					for pane in opened do table.insert(foreignHosts[pane] and foreign or panes, pane) end
					return {
						{ id = 1, name = "local", kind = "local", panes = foreign },
						{ id = 2, name = "agent", address = "agent.example", kind = remote and "remote" or "local", state = "connected", panes = panes },
					}
				end, current = function()
					live()
					if f.hostCurrentError then error("current host unavailable") end
					return { id = f.currentHost or 2, kind = remote and "remote" or "local", state = "connected" }
				end },
				new_block = function(_, kind, args, how, reveal)
					live(); assert(kind == "omp-client-bridge.panel" and how == "tab" and reveal.focus == false, "temporary tab must be created in the background")
					local owner = focused
					table.insert(f.creations, { target = owner, launch = { block = kind, args = copy(args) } })
					if f.missingHostBlock then return nil end
					nextPane += 1; f.panelPane = nextPane
					opened[nextPane], blocks[nextPane] = true, { block = kind, args = copy(args), owner = owner }
					nextTab += 1
					f.panelTab = nextTab
					paneTabs[nextPane] = nextTab
					tabs[nextTab] = { tab = nextTab, root = { pane = nextPane }, floats = {}, zoomed = false }
					if f.onCreate then f.onCreate(nextPane, nextTab) end
					return nextPane
				end,
				action = function(_, name) error("PiP must not traverse focus or resize splits: " .. tostring(name)) end,
				layout = setmetatable({ float = function(_, pane, owner, corner, reveal)
					live()
					assert(not inReceipt and callbackDelay ~= nil, "float must use a fresh deferred callback")
					assert(opened[pane] and opened[owner] and pane ~= owner, "float requires two existing distinct panes")
					assert(corner == "tr" and reveal.focus == false, "float must preserve focus at the native top-right corner")
					table.insert(f.floats, { pane = pane, owner = owner, sourceTab = paneTabs[pane], targetTab = paneTabs[owner] })
					-- Native false/throw results leave both source and target trees intact.
					if f.floatError then error("native float unavailable") end
					if f.floatFalse then return false end
					local targetTab = paneTabs[owner]
					detachPane(pane)
					paneTabs[pane] = targetTab
					table.insert(tabs[targetTab].floats, { pane = pane, over = owner, corner = "top_right", size = { 720, 420 }, focus_size = { 1080, 630 } })
					if f.onFloat then f.onFloat(pane, owner) end
					return true
				end }, { __index = function() error("unsupported window layout mutation") end }),
				run = function() error("numeric pane input must not be used") end,
				command = function(_, name) live(); table.insert(f.native, { command = name, pane = focused }) end,
				toast = function(_, level, title, message)
					live()
					table.insert(f.toasts, { level = level, title = title, message = message })
					if level == "error" then table.insert(f.errors, message) end
				end,
				pick = function(_, options)
					live()
					return { next = function(_, callback) table.insert(f.picks, { options = options, callback = callback }) end }
				end,
				prompt = function(_, options)
					live()
					return { next = function(_, callback) table.insert(f.prompts, { options = options, callback = callback }) end }
				end,
			}
			return cx, function() alive = false end
		end
		local function invoke(fn, ...)
			local cx, expire = context()
			local args = table.pack(...)
			args.n += 1
			args[args.n] = cx
			local result = fn(table.unpack(args, 1, args.n))
			expire()
			return result
		end
		tern = {
			plugin = { dir = "/isolated/plugin", data = "/isolated/plugin-data" },
			runtime = { os = "macos" },
			now = function() return clock end,
			log = { warn = function(prefix, value)
				if f.loggerFailure then error("native log unavailable") end
				assert(prefix == "[omp-client-bridge:panel]")
				table.insert(f.logs, copy(assert(encoded[value])))
			end },
			json = { encode = encode, decode = function(token)
				if token == "[]" then return {} end
				local value = copy(assert(encoded[token], "unknown JSON token"))
				if value.views then decodedState = value end
				return value
			end, null = null },
			kv = { get = function(key)
				ioCount += 1
				assert(key == "setup-hosts")
				if f.mappingReadError then error("private storage failure") end
				return copy(f.mapping)
			end, set = function(key, value)
				ioCount += 1
				assert(key == "setup-hosts")
				if f.mappingWriteError then error("private storage failure") end
				f.mapping = copy(value)
				table.insert(f.writes, copy(value))
			end },
			fs = { read = function(path)
				ioCount += 1
				table.insert(f.reads, path)
				if path == "/isolated/plugin-data/setup-state.json" then return encode(assert(f.setupProgress, "no setup state")) end
				if f.missingConnection then error("No such file or directory (os error 2)") end
				if path == "/isolated/plugin-data/config.json" then
					if f.configReadError then error(f.configReadError) end
					return encode(f.config or f.nativeConfig())
				end
				assert(path == "/isolated/client.json", "unexpected filesystem access")
				if f.missingEndpoint then error("No such file or directory (os error 2)") end
				if f.endpointReadError then error(f.endpointReadError) end
				return encode(f.endpoint or { url = "http://127.0.0.1:9999", token = "fixture-token" })
			end },
			fetch = function(url, options, callback)
				ioCount += 1
				if f.fetchError then error("fixture native fetch start failure") end
				assert(options.headers.Authorization == "Bearer fixture-token", "local UI authentication omitted")
				table.insert(requests, { path = url:sub(#"http://127.0.0.1:9999" + 1), body = options.body and copy(encoded[options.body]), timeout = options.timeout_ms, callback = callback })
			end,
			process = { run = function(argv, options, callback)
				ioCount += 1
				if f.spawnError then error("private launcher detail") end
				local process = { argv = copy(argv), options = copy(options), callback = callback }
				table.insert(f.processes, process)
				if argv[2] == "ctl" then
					assert(argv[1] ~= "tern", "PiP must not depend on the GUI PATH")
					assert(not inReceipt and callbackDelay ~= nil, "PiP process must start from a fresh timer, never a receipt")
					assert(argv[2] == "ctl" and argv[3] == "pip", "unexpected native process")
					local verb = argv[4]
					assert(verb == "resize" or verb == "focus", "unexpected PiP operation")
					local ordinalText = assert(argv[5]:match('^"#(%d+)"$'), "native ordinal must contain literal double quotes")
					local ordinal = tonumber(ordinalText)
					assert(options.env.TERN_WINDOW_KEY == (f.expectedWindowKey or f.windowKey) and options.timeout_ms == 3000, "PiP process must be bounded and pinned to this window")
					process.routeValid = options.env.TERN_PANE_SOCKET == f.nativePaneSocket()
					if not process.routeValid then
						table.insert(f.processReceipts, process)
						if f.onProcess then f.onProcess(process) end
						return
					end
					assert(#argv == (verb == "resize" and 7 or 5), "unexpected PiP CLI flags")
					local floating = assert(tabs[paneTabs[focused]].floats[ordinal], "current-tab PiP ordinal does not exist")
					assert(floating.pane == f.panelPane and floating.over == blocks[f.panelPane].owner, "ordinal selected an unrelated PiP")
					process.verb, process.pane = verb, floating.pane
					if verb == "resize" then
						assert(argv[6] == "240" and argv[7] == "360" and focused == floating.over, "portrait resize must run in owner-focused glance mode")
						floating.size, floating.focus_size = { 240, 360 }, { 360, 540 }
						table.insert(f.resizes, { pane = floating.pane, width = 240, height = 360 })
					else focused = floating.pane end
					table.insert(f.processReceipts, process)
					if f.onProcess then f.onProcess(process) end
				end
			end },
			timer = function(ms, callback)
				deferredDelays[callback] = ms
				table.insert(ms > 0 and ms <= 16 and deferred or timers, callback)
			end,
			sleep = function(_ms)
				return { next = function(_, callback)
					table.insert(deferred, function(cx) callback(nil, nil, cx) end)
				end }
			end,
			chrome = { refresh = function() end, status = function(callback) handlers.status = callback end },
			command = function(command) handlers[command.id] = command.run; f.commands[command.id] = command end,
			override = function() error("bridge must never override native paste or any native command") end,
			route = { open = function(fn) handlers.drop = fn end, link = function(fn) handlers.link = fn end },
			on = function(name, fn) handlers[name] = fn end,
		}
		function f.step()
			local callback = assert(table.remove(deferred, 1), "deferred callback missing")
			callbackDelay = deferredDelays[callback]
			deferredDelays[callback] = nil
			clock += callbackDelay or 0
			invoke(callback)
			callbackDelay = nil
		end
		function f.flush()
			local steps = 0
			while #deferred > 0 do
				if #f.processReceipts > 0 then
					if f.holdProcesses then return end
					f.processReceipt(nil, true)
				end
				steps += 1; assert(steps < 100, "deferred native work did not settle")
				f.step()
			end
		end
		function f.take(path, viewId)
			for index, request in requests do
				if request.path == path and (not viewId or request.body.viewId == viewId) then
					table.remove(requests, index)
					return request
				end
			end
			error("Missing request: " .. path)
		end
		function f.noRequest(path)
			for _, request in requests do assert(request.path ~= path, "Unexpected request: " .. path) end
		end
		function f.hasRequest(path)
			for _, request in requests do if request.path == path then return true end end
			return false
		end
		function f.respond(request, body, status, holdDeferred)
			local response = { status = status or 200, body = encode(body) }
			invoke(function(cx) inReceipt = true; request.callback(response, cx); inReceipt = false end)
			if not holdDeferred then f.flush() end
		end
		function f.processReceipt(result, holdDeferred)
			local process = assert(table.remove(f.processReceipts, 1), "process receipt missing")
			local receipt = result or { status = process.routeValid and 0 or 1, stdout = encode({ ok = process.routeValid }), timed_out = false }
			local processes, resizes, focusedBefore = #f.processes, #f.resizes, focused
			invoke(function(cx) inReceipt = true; process.callback(receipt, cx); inReceipt = false end)
			assert(#f.processes == processes and #f.resizes == resizes and focused == focusedBefore, "receipt performed native PiP work")
			if not holdDeferred then f.flush() end
		end
		function f.processResult(status, body, timedOut)
			return { status = status, stdout = type(body) == "table" and encode(body) or body, timed_out = timedOut or false }
		end
		function f.poll()
			local steps = 0
			while not f.hasRequest("/v1/state") do
				steps += 1
				assert(steps <= 20, "poll did not reach state request")
				local callback = assert(table.remove(timers, 1), "poll timer missing")
				invoke(callback)
				f.flush()
			end
			f.respond(f.take("/v1/state"), ui)
		end
		function f.tick()
			local callback = assert(table.remove(timers, 1), "timer missing")
			invoke(callback)
			f.flush()
		end
		-- Raw dispatch expires the route context without draining deferred work, so
		-- tests can observe the native handled result before any queued UI or IO.
		function f.dispatch(name, ...) return invoke(assert(handlers[name], "missing native handler"), ...) end
		function f.invoke(name, ...) local result = f.dispatch(name, ...); f.flush(); return result end
		function f.drop()
			return f.invoke("drop", { origin = "drop", host = "local", path = "/synthetic/图 one.txt" })
		end
		function f.focus(pane) focused = pane end
		function f.remote(value) remote = value end
		function f.connected(value) ui.connected = value end
		function f.surface(role, kind) surfaceRole, paneKind = role, kind end
		function f.outcomes(value) ui.outcomes = value; f.poll() end
		function f.approval(id)
			ui.interactions = { { id = id, title = "Approve client tool?", message = "Allow this native client operation once", choices = { { id = "allow-once", label = "Allow once" } } } }
			f.poll()
		end
		function f.choose(field, value)
			local pick = assert(table.remove(f.picks, 1), "native picker missing")
			local selected = nil
			if field then
				for _, item in pick.options.items do if item[field] == value then selected = item; break end end
				assert(selected, "picker choice missing")
			end
			invoke(function(cx) pick.callback(selected, nil, cx) end)
		end
		function f.clipboard()
			f.invoke("paste-remote")
			return f.take("/v1/captures/clipboard")
		end
		function f.pasted()
			local result = {}
			for _, request in requests do if request.path == "/v1/intents" and request.body.kind == "paste" then table.insert(result, request.body) end end
			return result
		end
		function f.setTransfers(items) ui.transfers = items; f.poll() end
		function f.status() return handlers.status({ pane = focused }) end
		function f.binding(id, devices)
			local view = assert(ui.views[f.viewId])
			view.state.binding.clientId = id or null
			view.state.devices = devices
			f.poll()
		end
		function f.advance(ms) clock += ms end
		function f.receipt(request)
			serial += 1
			local id = "resolve-" .. tostring(serial)
			if revoked[request.body.destinationId] then f.respond(request, { error = "Original destination closed" }, 400)
			else f.respond(request, { id = id, expiresAt = 60000 }) end
			return id
		end
		function f.publish(request, id, session, draft)
			local viewId = request.body.viewId
			ui.views[viewId] = {
				viewId = viewId, destinationId = request.body.destinationId, resolveIntentId = id, sessionId = session, draftToken = draft,
				state = { serverInstance = "broker-fixture", binding = { sessionId = session, clientId = null, revision = 0 }, devices = {} },
			}
			f.poll()
		end
		function f.resolve(request, session, draft)
			local id = f.receipt(request)
			f.publish(request, id, session, draft)
			return id
		end
		function f.warm()
			f.poll()
			local request = f.take("/v1/intents")
			f.viewId = request.body.viewId
			f.resolve(request, "session-A", "draft-A")
		end
		function f.captureDrop()
			assert(f.drop().handled == true, "remote drop was not consumed")
			return f.take("/v1/captures")
		end
		function f.capture(request, id)
			f.respond(request, { id = id, kind = "files", names = { "图 one.txt" } })
			return f.take("/v1/intents", f.viewId)
		end
		function f.released(id)
			local request = f.take("/v1/captures/release")
			assert(request.body.id == id, "released a different gesture's capture")
			f.respond(request, { ok = true })
		end
		function f.ready(transferId)
			ui.transfers = { { id = transferId, viewId = f.viewId, phase = "ready", names = { "图 one.txt" }, bytesSent = 8, totalBytes = 8 } }
			f.poll()
		end
		function f.mutateCachedIdentity(session, draft)
			-- Adversarial alias check: a consumer changing the previously decoded table
			-- must not change the gesture's already-captured scalar destination.
			local view = assert(decodedState.views[f.viewId])
			view.sessionId, view.draftToken = session, draft
		end
		function f.invalidateOriginal()
			removePane(original)
			revoked[destinations[original]] = true
			ui.views[f.viewId] = nil
		end
		function f.closeOriginal()
			removePane(original)
			focused = other
			f.invoke("pane_closed", { pane = original })
			revoked[destinations[original]] = true
			ui.views[f.viewId] = nil
			f.poll()
		end
		function f.chromeIsPure()
			local before = ioCount
			assert(#handlers.status({ pane = original }) > 0, "status disappeared")
			assert(ioCount == before, "chrome formatter performed IO")
		end
		function f.flushPanels()
			local steps = 0
			while f.hasRequest("/v1/panels/close") or f.hasRequest("/v1/panels/open") or f.hasRequest("/v1/panels/publish") do
				steps += 1; assert(steps < 10, "panel publication loop")
				if f.hasRequest("/v1/panels/close") then
					local r = f.take("/v1/panels/close")
					for pane, block in blocks do
						if block.args[1] == r.body.owner and block.args[2] == r.body.panelId then
							table.insert(f.closes, pane)
							removePane(pane)
						end
					end
					f.respond(r, { ok = true })
				else
					local r = f.take(f.hasRequest("/v1/panels/open") and "/v1/panels/open" or "/v1/panels/publish")
					table.insert(f.snapshots, { value = copy(r.body.snapshot) })
					f.respond(r, { ok = true })
				end
			end
		end
		function f.toggle() f.invoke("toggle-bridge"); f.flushPanels() end
		function f.linkRequest(verb, pane, owner, id)
			local args = f.creations[#f.creations].launch.args
			local clicked = pane or f.panelPane
			if opened[clicked] then focused = clicked end
			return { pane = clicked, url = "omp-bridge-panel://" .. (owner or args[1]) .. "/" .. (id or args[2]) .. "/" .. verb }
		end
		function f.link(verb, pane, owner, id)
			local result = f.invoke("link", f.linkRequest(verb, pane, owner, id))
			if verb == "hide" then f.flushPanels() end
			return result
		end
		function f.ioCount() return ioCount end
		function f.isOpen(pane) return opened[pane] == true end
		function f.layout(root)
			if root then layout.root = copy(root); originalRoot = copy(root) end
			local result = copy(layout)
			result.focus = focused
			result.activeTab = paneTabs[focused]
			return result
		end
		function f.assertOriginalTab()
			assert(tabs[1] == layout and sameTree(layout.root, originalRoot), "PiP changed the original tab tree or split ratios")
			assert(opened[original] and opened[other], "PiP closed an existing agent pane")
		end
		function f.foreign(pane) foreignHosts[pane] = true end
		function f.addPane(pane)
			opened[pane], paneTabs[pane] = true, 1
			destinations[pane] = "destination-" .. tostring(pane)
		end
		function f.movePaneToTab(pane)
			detachPane(pane)
			nextTab += 1
			paneTabs[pane] = nextTab
			tabs[nextTab] = { tab = nextTab, root = { pane = pane }, floats = {}, zoomed = false }
			return nextTab
		end
		function f.addTabPane(pane)
			nextTab += 1
			opened[pane], paneTabs[pane] = true, nextTab
			tabs[nextTab] = { tab = nextTab, root = { pane = pane }, floats = {}, zoomed = false }
			destinations[pane] = "destination-" .. tostring(pane)
			return nextTab
		end
		function f.tab(id) return copy(tabs[id]) end
		function f.paneTab(pane) return paneTabs[pane] end
		function f.floating(pane) return copy(floatingPane(tabs[paneTabs[pane] or 1], pane)) end
		function f.userResize(pane, width, height)
			local floating = assert(floatingPane(tabs[paneTabs[pane]], pane))
			floating[focused == pane and "focus_size" or "size"] = { width, height }
		end
		function f.addFloat(pane, owner, first)
			opened[pane], paneTabs[pane] = true, paneTabs[owner]
			local floats = tabs[paneTabs[owner]].floats
			table.insert(floats, first and 1 or #floats + 1, { pane = pane, over = owner, corner = "bottom_left", size = { 315, 210 }, focus_size = { 490, 330 } })
		end
		function f.removeFloat(pane) removePane(pane) end
		function f.closePanel()
			local block = blocks[f.panelPane]
			removePane(f.panelPane)
			ui.panels = { { owner = block.args[1], panelId = block.args[2], destinationId = "destination-A", phase = "closed" } }
			if not opened[focused] then focused = original end
			f.poll()
		end
		local function requireModule(name)
			table.insert(f.moduleLoads, name)
			if f.moduleError then error("fixture module unavailable") end
			if name == './setup-controller' and f.fakeSetup then
				-- Controller has its own shipped-module harness. This seam supplies
				-- verified completion/readiness notifications to the real window router.
				return { new = function(_, callbacks)
					f.setupCallbacks = callbacks
					return {
						open = function() f.setupOpens += 1 end,
						hide = function() f.setupHidden = true end,
						route = function() return nil end,
						closed = function() end,
						commandFinished = function() end,
					}
				end }
			end
			return loadModule(name)
		end
		function f.reload() handlers, timers, deferred, deferredDelays = {}, {}, {}, {}; entry(requireModule) end
		function f.latestSnapshot() f.flushPanels(); return f.snapshots[#f.snapshots].value end
		function f.completeSetup()
			f.fakeSetup = true
			f.invoke("setup")
			local turns = 0
			while f.setupOpens == 0 do turns += 1; assert(turns < 20); f.tick() end
			f.setupCallbacks.onState({ phase = "awaiting_session", stage = "awaiting-session", message = "Open remote OMP on agent with its extension loaded", ssh = "agent" })
			local readiness = f.setupCallbacks.onConnected()
			f.setupCallbacks.refresh()
			return readiness
		end
		entry(requireModule)
		return f
	end
	local function case(name, body)
		body(fixture())
		passed += 1
		print("PASS synthetic shipped-plugin behavior: " .. name)
	end

	case("panel diagnostics explain admission without exposing private context", function(f)
		f.warm()
		f.toggle()
		local seen = {}
		for _, item in f.logs do
			seen[item.event] = true
			for key, value in item do
				if type(value) == "string" then
					assert(key == "event" or key == "window", "unapproved text in diagnostics")
					for _, secret in { "fixture-token", "destination-A", "session-A", "draft-A", "/synthetic", "/isolated/Tern CLI", "http://" } do
						assert(not value:find(secret, 1, true), "private diagnostic payload")
					end
				end
			end
		end
		assert(seen["entry.command"] and seen["target.ready"] and seen["panel.open.request"])
		assert(seen["panel.http.response"] and seen["panel.block.result"] and seen["panel.opened"])
		assert(#f.creations == 1)
	end)

	case("panel diagnostics bound click floods and survive logger failure", function(f)
		f.warm()
		f.remote(false)
		for _ = 1, 100 do f.toggle() end
		assert(#f.logs <= 41 and f.logs[#f.logs].event == "rate_limited")
		f.advance(10001)
		f.loggerFailure = true
		f.remote(true)
		f.toggle()
		assert(#f.creations == 1 and #f.errors == 0, "logging changed panel behavior: " .. table.concat(f.errors, "; "))
	end)

	case("missing installation exposes setup without starting a process", function(f)
		f.missingConnection = true
		f.tick()
		assert(f.status()[1].command == "plugin.omp-client-bridge.setup")
		assert(#f.processes == 0 and #f.sent == 0)
		f.chromeIsPure()
	end)


	case("verified install with absent endpoint stays awaiting and later opens ordinary Bridge", function(f)
		f.missingEndpoint = true
		assert(f.completeSetup() == "awaiting")
		assert(f.status()[1].text == "Waiting for local Bridge")
		assert(#f.processes == 0 and #f.sent == 0)
		f.chromeIsPure()
		f.missingEndpoint = false
		f.poll()
		assert(f.setupCallbacks.onConnected() == "ready")
		f.setupCallbacks.onState({ phase = "failed", stage = "Old setup error" })
		f.setupCallbacks.refresh()
		f.currentSession = 2
		f.focus(f.other)
		f.toggle()
		assert(#f.creations == 1 and f.setupOpens == 1, "cached setup failure trapped Bridge routing")
		assert(f.floating(f.panelPane) and f.layout().focus == f.panelPane, "unresolved broker view prematurely closed panel initialization")
		assert(f.setupHidden, "ordinary Bridge left the old setup display open")
		f.closePanel()
		f.currentSession = 3
		f.focus(f.original)
		f.toggle()
		assert(#f.creations == 2 and f.setupOpens == 1)
	end)

	case("verified install with absent config never becomes a reinstall requirement", function(f)
		f.missingConnection = true
		assert(f.completeSetup() == "awaiting")
		f.tick()
		assert(f.status()[1].text == "Waiting for local Bridge")
		f.missingConnection = false
		f.poll()
		assert(f.setupCallbacks.onConnected() == "ready")
	end)

	case("setup module load failure is visible and a later explicit open can recover", function(f)
		f.moduleError, f.fakeSetup = true, true
		f.invoke("setup")
		f.tick(); f.tick()
		assert(#f.errors == 1 and f.errors[1]:find("reload", 1, true))
		f.moduleError = false
		assert(f.completeSetup() == "ready")
	end)

	for _, fault in { "Permission denied (os error 13)", "invalid UTF-8 bytes" } do
		case("endpoint read fault is actionable rather than reinstall: " .. fault, function(f)
			f.endpointReadError = fault
			f.tick(); f.tick()
			assert(f.status()[1].text == "Bridge endpoint needs attention")
			f.toggle()
			assert(#f.moduleLoads == 0 and #f.errors == 1 and f.errors[1]:find("permissions", 1, true))
			f.endpointReadError = nil
			f.poll()
			assert(f.status()[1].text ~= "Bridge endpoint needs attention")
			f.chromeIsPure()
		end)
	end

	for _, platform in { "macos", "linux", "windows" } do
		case("OS error 3 is missing metadata only on Windows: " .. platform, function(f)
			tern.runtime.os = platform
			f.endpointReadError = "Fixture filesystem failure (os error 3)"
			f.tick(); f.tick()
			assert(f.status()[1].text == (platform == "windows" and "Waiting for local Bridge" or "Bridge endpoint needs attention"))
			f.noRequest("/v1/state")
			f.chromeIsPure()
		end)
	end

	case("unsafe endpoint is never fetched and corrected metadata recovers", function(f)
		f.endpoint = { url = "https://agent.example", token = "fixture-token" }
		f.tick(); f.tick()
		f.noRequest("/v1/state")
		assert(f.status()[1].text == "Bridge endpoint needs attention")
		f.endpoint = nil
		f.poll()
		assert(f.status()[1].text ~= "Bridge endpoint needs attention")
	end)

	case("synchronous fetch failure releases polling guard for a later retry", function(f)
		f.fetchError = true
		f.tick(); f.tick(); f.tick()
		assert(f.status()[1].text == "Bridge endpoint needs attention")
		f.fetchError = false
		f.poll()
		assert(f.status()[1].text ~= "Bridge endpoint needs attention")
	end)

	for _, context in { "local", "terminal", "other agent", "missing widget" } do
		case("unsupported panel context is informational and cannot poison remote status: " .. context, function(f)
			f.warm()
			f.focus(f.other)
			if context == "local" then f.remote(false)
			elseif context == "terminal" then f.surface("terminal", "terminal")
			elseif context == "other agent" then f.surface("other.session", "agent")
			else f.noWidget = true end
			local before = f.ioCount()
			f.toggle()
			assert(#f.creations == 0 and #f.errors == 0 and #f.toasts == 1)
			assert(f.toasts[1].level == "info" and f.toasts[1].message:find(context == "missing widget" and "extension" or "remote OMP", 1, true))
			assert(f.ioCount() == before, "unsupported context started Bridge work")
			assert(f.status()[1].text == "Connected · No session", "context feedback changed global health")
			f.chromeIsPure()
			f.remote(true); f.surface("omp.session", "agent"); f.noWidget = false
			f.focus(f.original)
			-- Do not poll here: a successful state response clears statusError and
			-- would hide contamination caused by the preceding unsupported click.
			f.toggle()
			assert(#f.creations == 1 and #f.errors == 0)
			assert(f.status()[1].text == "Connected · Unbound")
			assert(f.latestSnapshot().error == nil, "local usage poisoned the valid remote panel")
		end)
	end

	case("local panel context cannot clear a genuine panel-open failure", function(f)
		f.warm()
		f.invoke("toggle-bridge")
		f.respond(f.take("/v1/panels/open"), { error = "Fixture panel service unavailable" }, 503)
		assert(#f.errors == 1 and f.errors[1] == "Fixture panel service unavailable")
		assert(f.status()[1].text == "Needs attention")
		f.remote(false); f.focus(f.other)
		f.toggle()
		assert(#f.errors == 1 and f.toasts[#f.toasts].level == "info")
		assert(f.status()[1].text == "Needs attention", "local feedback cleared a genuine fault")
		f.noRequest("/v1/panels/open")
	end)

	case("disconnected Bridge remains an error for a valid remote panel target", function(f)
		f.warm()
		f.connected(false); f.poll()
		f.toggle()
		assert(#f.errors == 1 and f.errors[1] == "This device's Bridge connection is unavailable")
		assert(f.status()[1].text == "Needs attention" and #f.creations == 0)
		f.noRequest("/v1/panels/open")
	end)

	case("ordinary Bridge relocates its view without moving an in-flight capture", function(f)
		f.warm()
		f.toggle()
		local first = f.panelPane
		f.link("upload")
		local capture = f.take("/v1/captures/pick-file")
		f.currentSession = 2
		f.focus(f.other)
		f.toggle()
		assert(#f.closes == 1 and f.closes[1] == first and #f.creations == 2)
		assert(f.panelPane ~= first and f.isOpen(f.original) and f.isOpen(f.other))
		f.noRequest("/v1/transfers/cancel")
		f.resolve(f.capture(capture, "relocated-file"), "session-A", "draft-A")
		local upload = f.take("/v1/transfers")
		assert(upload.body.viewId == f.viewId and upload.body.expectedSessionId == "session-A")
		f.respond(upload, { id = "relocated-transfer", phase = "uploading" })
		f.ready("relocated-transfer", "original-attachment")
		assert(#f.sent == 0, "window replayed a broker-delivered attachment")
	end)


	case("status shows the selected agent device and follows original panel context", function(f)
		f.warm()
		print("STATUS unbound: " .. f.status()[1].text)
		f.binding("selected", {
			{ id = "other-device", name = "Wrong device", online = true, platform = "darwin" },
			{ id = "selected", name = "Dev Mac", online = true, platform = "darwin" },
		})
		assert(f.status()[1].text:find("Dev Mac", 1, true))
		assert(not f.status()[1].text:find("Wrong device", 1, true))
		print("STATUS bound: " .. f.status()[1].text)
		f.toggle()
		f.focus(f.panelPane)
		assert(f.status()[1].text:find("Dev Mac", 1, true), "panel focus lost its original agent device")
		f.binding("selected", { { id = "selected", name = "Dev Mac", online = false, platform = "darwin" } })
		assert(f.status()[1].tone == "warn")
		print("STATUS device offline: " .. f.status()[1].text)
		f.connected(false)
		f.poll()
		assert(not f.status()[1].text:find("Dev Mac", 1, true), "disconnected status presented stale binding as live")
		print("STATUS disconnected: " .. f.status()[1].text)
		f.chromeIsPure()
	end)

	local function nestedOriginal(f)
		local third, fourth = f.original + 100, f.original + 101
		f.addPane(third); f.addPane(fourth)
		f.layout({ split = "right", ratio = 0.550000011920929,
			{ split = "down", ratio = 0.37, { pane = f.original }, { pane = third } },
			{ split = "down", ratio = 0.71, { pane = f.other }, { pane = fourth } },
		})
	end

	case("isolated creation and cross-tab float preserve the entire nonuniform original tree", function(f)
		nestedOriginal(f)
		f.warm()
		f.hiddenPanelSurfaceMissing = true
		local created, floated = false, false
		f.onCreate = function(pane, tab)
			created = true
			f.assertOriginalTab()
			assert(tab ~= 1 and f.paneTab(pane) == tab and f.tab(tab).root.pane == pane, "panel was inserted into the existing layout")
			assert(f.layout().focus == f.original and f.layout().activeTab == 1 and #f.layout().floats == 0, "background tab was shown or stole focus")
		end
		f.onFloat = function(pane, owner)
			floated = true
			f.assertOriginalTab()
			assert(pane == f.panelPane and owner == f.original, "float moved a different pane or selected another owner")
			assert(f.paneTab(pane) == 1 and f.tab(f.panelTab) == nil, "float retained its empty temporary tab")
			assert(f.layout().focus == f.original, "native float did not return to the owner")
		end
		f.onProcess = function() f.assertOriginalTab() end
		f.toggle()
		assert(created and floated and #f.floats == 1)
		assert(f.layout().focus == f.panelPane, "panel did not become interactive")
		f.link("hide")
		f.assertOriginalTab()
		assert(not f.isOpen(f.panelPane) and next(f.layout().floats) == nil and f.tab(f.panelTab) == nil)
	end)

	for _, failure in { "floatFalse", "floatError" } do
		case("native " .. failure .. " self-closes only the owned temporary panel", function(f)
			nestedOriginal(f)
			local unrelated = f.original + 200
			local unrelatedTab = f.addTabPane(unrelated)
			f.warm()
			f[failure] = true
			f.toggle()
			assert(#f.floats == 1 and f.floats[1].pane == f.panelPane and f.floats[1].owner == f.original)
			assert(#f.closes == 1 and f.closes[1] == f.panelPane and not f.isOpen(f.panelPane), "float failure did not request the owned block's broker self-close")
			assert(f.tab(f.panelTab) == nil and next(f.layout().floats) == nil, "failed float left its temporary tab or PiP behind")
			assert(f.isOpen(unrelated) and f.tab(unrelatedTab).root.pane == unrelated, "failure cleanup touched an unrelated tab")
			assert(#f.resizes == 0 and #f.actions == 0 and #f.errors == 1)
			f.assertOriginalTab()
			f.poll(); f.flushPanels()
			assert(#f.floats == 1 and #f.closes == 1, "poll retried failed float or closed another panel")
		end)
	end

	for _, change in { "focus", "tab", "host", "session", "closed owner", "foreign owner", "moved owner", "owner destination", "aliased surface" } do
		case("temporary panel cancels before float after changed " .. change, function(f)
			f.warm()
			f.invoke("toggle-bridge")
			f.respond(f.take("/v1/panels/open"), { ok = true }, nil, true)
			local pane, temporaryTab = f.panelPane, f.panelTab
			assert(pane and f.tab(temporaryTab).root.pane == pane and #f.floats == 0)
			f.assertOriginalTab()
			local userPane
			if change == "focus" then userPane = f.other; f.focus(userPane)
			elseif change == "tab" then userPane = f.original + 200; f.addTabPane(userPane); f.focus(userPane)
			elseif change == "host" then f.currentHost = 3
			elseif change == "session" then f.currentSession = 2
			elseif change == "closed owner" then f.invalidateOriginal()
			elseif change == "foreign owner" then f.foreign(f.original)
			elseif change == "moved owner" then f.movePaneToTab(f.original)
			elseif change == "owner destination" then f.destinationOverride = { [f.original] = "replacement-destination" }
			else f.panelSurfaceAlias = f.other; userPane = f.other; f.focus(userPane) end
			f.flush(); f.flushPanels()
			assert(#f.floats == 0 and #f.actions == 0 and #f.resizes == 0, "changed context still received native PiP work")
			assert(#f.closes == 1 and f.closes[1] == pane and not f.isOpen(pane) and f.tab(temporaryTab) == nil, "cancelled preparation stranded its temporary panel")
			assert(f.isOpen(f.other))
			if userPane then assert(f.layout().focus == userPane and f.isOpen(userPane), "cleanup stole the user's selected context") end
			if change == "closed owner" or change == "moved owner" then
				assert(f.layout().root.pane == f.other, "cleanup rewrote the user's changed original layout")
			else f.assertOriginalTab() end
		end)
	end

	case("Bridge toggle owns only its native panel and retains original target", function(f)
		f.warm()
		f.toggle()
		assert(#f.creations == 1 and f.creations[1].target == f.original, "panel lost the captured OMP owner")
		assert(f.creations[1].launch.block == "omp-client-bridge.panel")
		local first = f.panelPane
		local pip = assert(f.floating(first), "Bridge did not automatically float")
		assert(pip.over == f.original and pip.corner == "top_right" and pip.size[1] == 240 and pip.size[2] == 360 and pip.focus_size[1] == 360 and pip.focus_size[2] == 540, "Bridge did not initialize both native portrait sizes")
		assert(f.paneTab(first) == 1 and f.tab(f.panelTab) == nil, "float left the panel in its temporary tab")
		assert(f.layout().focus == first, "Bridge is not focused for interaction by default")
		f.assertOriginalTab()
		local resizes, processes = #f.resizes, #f.processes
		assert(resizes == 1 and processes == 2, "automatic PiP must resize then focus exactly once")
		f.userResize(first, 411, 609)
		f.focus(f.original); f.userResize(first, 281, 433)
		f.poll(); f.focus(first); f.invoke("focus", {}); f.poll()
		assert(#f.resizes == resizes and #f.processes == processes, "focus loss or polling reapplied geometry")
		assert(f.link("paste").handled)
		f.respond(f.take("/v1/captures/clipboard"), { kind = "text", text = "panel text" })
		f.resolve(f.take("/v1/intents", f.viewId), "session-A", "draft-A")
		assert(f.pasted()[1].viewId == f.viewId and f.pasted()[1].sessionId == "session-A", "panel paste followed panel focus")
		assert(#f.picks == 0 and #f.prompts == 0, "explicit paste opened a redundant dialog")
		assert(f.floating(first).focus_size[1] == 411 and f.floating(first).focus_size[2] == 609 and f.floating(first).size[1] == 281 and f.floating(first).size[2] == 433, "paste or polling overwrote either user size")
		f.link("hide")
		assert(#f.closes == 1 and f.closes[1] == first and f.isOpen(f.original) and f.isOpen(f.other))
		assert(f.floating(first) == nil and not f.isOpen(first), "hide left its owned PiP behind")
		f.assertOriginalTab()
		f.noRequest("/v1/transfers/cancel")
		f.toggle()
		assert(f.panelPane ~= first and #f.creations == 2 and #f.resizes == resizes + 1 and #f.processes == processes + 2)
		assert(f.floating(f.panelPane).corner == "top_right" and f.floating(f.panelPane).size[1] == 240 and f.floating(f.panelPane).focus_size[2] == 540)
		f.assertOriginalTab()
		assert(f.creations[1].launch.args[2] ~= f.creations[2].launch.args[2], "recreated panel reused stale route id")
	end)

	case("automatic PiP focuses its panel without input or original layout mutation", function(f)
		f.warm(); f.toggle()
		assert(#f.floats == 1 and f.floats[1].pane == f.panelPane and f.floats[1].owner == f.original, "Bridge floated another pane or owner")
		assert(f.layout().focus == f.panelPane and f.paneTab(f.panelPane) == 1, "Bridge did not focus the panel over its original tab")
		assert(#f.sent == 0 and #f.native == 0 and #f.processes == 2 and #f.actions == 0, "PiP must use only two local bounded ctl processes, not pane input or focus traversal")
		f.assertOriginalTab()
		local processes, resizes = #f.processes, #f.resizes
		f.focus(f.other); f.poll(); f.advance(5000); f.poll(); f.flushPanels()
		assert(f.layout().focus == f.other and #f.processes == processes and #f.resizes == resizes, "heartbeat stole focus or reapplied PiP geometry")
	end)

	for _, location in {
		{ "macos", "/Applications/Tern App.app/Contents/MacOS/tern" },
		{ "linux", "/opt/Tern CLI/bin/tern" },
		{ "linux", "/opt/Tern's $tools; local/bin/tern" },
		{ "macos", "/opt/Tern CLI/tern launcher" },
		{ "linux", "//opt/Tern\\literal/bin/tern" },
		{ "windows", "C:\\Program Files\\Tern\\tern.EXE" },
		{ "windows", "D:/Tern CLI/tern.exe" },
		{ "windows", "\\\\client-server\\shared tools\\Tern CLI\\tern.ExE" },
		{ "windows", "//client-server/shared tools/Tern CLI/tern.exe" },
		{ "windows", "\\\\?\\C:\\Program Files\\Tern\\tern.exe" },
		{ "windows", "\\\\?\\UNC\\client-server\\shared tools\\tern.exe" },
	} do
		case("machine-local " .. location[1] .. " CLI path launches unchanged: " .. location[2], function(f)
			tern.runtime.os = location[1]
			f.config = f.nativeConfig(); f.config.ternExecutable = location[2]
			f.endpoint = { url = "http://127.0.0.1:9999", token = "fixture-token", ternExecutable = "/wrong/endpoint/tern" }
			f.warm(); f.toggle()
			assert(#f.creations == 1 and #f.processes == 2 and #f.errors == 0)
			assert(f.processes[1].argv[1] == location[2] and f.processes[2].argv[1] == location[2], "configured executable was split, quoted, normalized, or replaced")
			assert(#f.processes[1].argv == 7 and #f.processes[2].argv == 5, "path spaces became command arguments")
			assert(f.layout().focus == f.panelPane and #f.resizes == 1)
			f.assertOriginalTab()
		end)
	end

	for _, invalid in {
		{ "macos", nil, "missing" },
		{ "macos", false, "non-string" },
		{ "macos", "", "empty" },
		{ "macos", "tern", "bare name" },
		{ "linux", "./bin/tern", "relative" },
		{ "macos", "C:\\Tern\\tern.exe", "Windows drive on macOS" },
		{ "linux", "\\\\server\\share\\tern.exe", "Windows UNC on Linux" },
		{ "windows", "/opt/tern", "POSIX on Windows" },
		{ "windows", "C:tern.exe", "drive-relative" },
		{ "windows", "\\Tern\\tern.exe", "root-relative" },
		{ "windows", "\\\\server\\tern.exe", "incomplete UNC" },
		{ "windows", "C:\\Tern\\tern.cmd", "command shim" },
		{ "windows", "C:\\Tern\\tern.exe --help", "Windows command arguments" },
		{ "macos", '"/Applications/Tern CLI/tern"', "quoted command" },
		{ "linux", "/opt/tern\n", "control character" },
		{ "macos", "/opt/tern" .. utf8.char(133), "C1 control character" },
		{ "windows", "C:\\Tern\\" .. string.char(0) .. "tern.exe", "NUL character" },
		{ "linux", "/opt/" .. string.char(127) .. "tern", "DEL character" },
		{ "macos", "/", "root directory" },
	} do
		case("invalid CLI " .. invalid[3] .. " blocks only PiP, not independent paste or upload", function(f)
			tern.runtime.os = invalid[1]
			f.config = f.nativeConfig(); f.config.ternExecutable = invalid[2]
			f.warm(); f.toggle()
			assert(#f.creations == 0 and #f.processes == 0 and #f.floats == 0, "invalid CLI stranded a temporary panel or launched a process")
			f.noRequest("/v1/panels/open")
			assert(#f.errors == 1 and f.errors[1]:find("ternExecutable", 1, true) and f.errors[1]:find("install-tern", 1, true) and f.errors[1]:find("reload", 1, true), "missing actionable local CLI repair")
			f.respond(f.clipboard(), { kind = "text", text = "independent paste" })
			f.resolve(f.take("/v1/intents", f.viewId), "session-A", "draft-A")
			assert(#f.pasted() == 1 and f.pasted()[1].text == "independent paste", "CLI configuration disabled endpoint paste")
			f.take("/v1/intents", f.viewId)
			f.invoke("upload-file")
			f.resolve(f.capture(f.take("/v1/captures/pick-file"), "independent-file"), "session-A", "draft-A")
			assert(f.take("/v1/transfers").body.captureId == "independent-file", "CLI configuration disabled endpoint upload")
			assert(#f.errors == 1 and #f.creations == 0 and #f.processes == 0)
			f.assertOriginalTab()
		end)
	end

	case("repairing invalid executable configuration and reloading restores PiP", function(f)
		f.config = f.nativeConfig(); f.config.ternExecutable = "tern"
		f.warm(); f.toggle()
		assert(#f.creations == 0 and #f.processes == 0 and #f.errors == 1)
		f.config.ternExecutable = "/repaired/Tern CLI/tern"
		f.reload(); f.warm(); f.toggle()
		assert(#f.creations == 1 and #f.processes == 2 and #f.errors == 1)
		assert(f.processes[1].argv[1] == "/repaired/Tern CLI/tern" and f.processes[2].argv[1] == "/repaired/Tern CLI/tern")
		assert(f.layout().focus == f.panelPane and f.status()[1].text ~= "Needs attention")
	end)

	for _, location in {
		{ "macos", "/Users/Fixture/Library/Application Support/Tern/daemon.sock" },
		{ "linux", "/run/user/1000/tern/daemon" },
		{ "linux", "/opt/Tern's $tools; local/daemon.sock" },
		{ "macos", "//local/Tern\\literal/daemon.sock" },
		{ "windows", "C:\\Users\\Fixture\\Tern Data\\daemon.sock" },
		{ "windows", "D:/Tern Data/daemon" },
		{ "windows", "\\\\client-server\\shared tools\\Tern\\daemon.sock" },
		{ "windows", "//client-server/shared tools/Tern/daemon.sock" },
		{ "windows", "\\\\?\\C:\\Tern Data\\daemon.sock" },
		{ "windows", "\\\\?\\UNC\\client-server\\shared tools\\daemon.sock" },
	} do
		case("machine-local " .. location[1] .. " socket is passed unchanged: " .. location[2], function(f)
			tern.runtime.os = location[1]
			f.daemonSocket = location[2]
			f.config = f.nativeConfig()
			f.endpoint = { url = "http://127.0.0.1:9999", token = "fixture-token", ternPaneSocket = "/wrong/endpoint/daemon.sock" }
			f.warm(); f.toggle()
			assert(#f.processes == 2 and #f.errors == 0 and #f.resizes == 1 and f.layout().focus == f.panelPane)
			for _, process in f.processes do
				assert(process.options.env.TERN_PANE_SOCKET == location[2], "socket was normalized, quoted, or replaced by endpoint metadata")
			end
			f.assertOriginalTab()
		end)
	end

	for _, invalid in {
		{ "macos", nil, "missing" },
		{ "macos", false, "non-string" },
		{ "macos", "", "empty" },
		{ "macos", "daemon.sock", "bare name" },
		{ "linux", "./daemon.sock", "relative" },
		{ "macos", "C:\\Tern\\daemon.sock", "Windows drive on macOS" },
		{ "linux", "\\\\server\\share\\daemon.sock", "Windows UNC on Linux" },
		{ "windows", "/run/tern/daemon.sock", "POSIX on Windows" },
		{ "windows", "C:daemon.sock", "drive-relative" },
		{ "windows", "\\Tern\\daemon.sock", "root-relative" },
		{ "windows", "\\\\server\\daemon.sock", "incomplete UNC" },
		{ "windows", "\\\\.\\pipe\\tern", "device namespace" },
		{ "windows", "C:\\Tern\\daemon:sock", "alternate stream" },
		{ "windows", "C:\\Tern\\daemon?.sock", "wildcard" },
		{ "windows", "C:\\Tern\\", "directory suffix" },
		{ "windows", "\\\\?\\C:daemon.sock", "extended drive-relative" },
		{ "macos", '\"/run/Tern Data/daemon.sock\"', "quoted path" },
		{ "linux", "http://127.0.0.1:9999", "URL" },
		{ "linux", "/run/daemon.sock\n", "control character" },
		{ "macos", "/run/daemon.sock" .. utf8.char(133), "C1 control character" },
		{ "windows", "C:\\Tern\\" .. string.char(0) .. "daemon.sock", "NUL character" },
		{ "linux", "/run/" .. string.char(127) .. "daemon.sock", "DEL character" },
		{ "macos", "/run/" .. string.char(255) .. "daemon.sock", "invalid UTF-8" },
		{ "macos", "/", "root directory" },
	} do
		case("invalid socket " .. invalid[3] .. " fails before panel creation without disabling paste", function(f)
			tern.runtime.os = invalid[1]
			f.config = f.nativeConfig(); f.config.ternPaneSocket = invalid[2]
			f.endpoint = { url = "http://127.0.0.1:9999", token = "fixture-token", ternPaneSocket = f.nativePaneSocket() }
			f.warm(); f.toggle()
			assert(#f.creations == 0 and #f.processes == 0 and #f.floats == 0, "invalid socket created a panel or used a hidden native fallback")
			f.noRequest("/v1/panels/open")
			assert(#f.errors == 1 and f.errors[1]:find("ternPaneSocket", 1, true) and f.errors[1]:find("install-tern --tern-pane-socket", 1, true) and f.errors[1]:find("reload", 1, true))
			f.respond(f.clipboard(), { kind = "text", text = "independent socket paste" })
			f.resolve(f.take("/v1/intents", f.viewId), "session-A", "draft-A")
			assert(#f.pasted() == 1 and f.pasted()[1].text == "independent socket paste")
			f.assertOriginalTab()
		end)
	end

	case("well-formed wrong socket cannot simulate successful native initialization", function(f)
		f.config = f.nativeConfig(); f.config.ternPaneSocket = "/wrong/daemon.sock"
		f.warm(); f.toggle()
		assert(#f.processes == 1 and not f.processes[1].routeValid and #f.resizes == 0 and #f.errors == 1)
		assert(f.layout().focus == f.original and f.isOpen(f.panelPane), "failed socket dispatch stole focus or closed a floated panel")
		local failed = false
		for _, item in f.logs do
			assert(item.event ~= "panel.pip.ready", "wrong socket was counted as initialized")
			if item.event == "panel.pip.failed" then failed = true; assert(item.exitCode == 1 and item.nativeOk == false) end
		end
		assert(failed)
		f.poll(); f.flushPanels(); assert(#f.processes == 1, "wrong route caused a retry or fallback")
		f.assertOriginalTab()
	end)

	case("repairing missing socket metadata and reloading restores PiP", function(f)
		f.config = f.nativeConfig(); f.config.ternPaneSocket = nil
		f.warm(); f.toggle()
		assert(#f.creations == 0 and #f.errors == 1)
		f.config.ternPaneSocket = f.nativePaneSocket()
		f.reload(); f.warm(); f.toggle()
		assert(#f.processes == 2 and #f.resizes == 1 and f.layout().focus == f.panelPane and #f.errors == 1)
	end)

	case("empty GUI window key is captured alongside the native daemon socket", function(f)
		f.windowKey, f.expectedWindowKey = "", ""
		f.warm()
		f.onCreate = function() f.windowKey = "later-window-context" end
		f.toggle()
		assert(#f.processes == 2 and #f.errors == 0 and f.layout().focus == f.panelPane)
		for _, process in f.processes do
			assert(process.options.env.TERN_WINDOW_KEY == "" and process.options.env.TERN_PANE_SOCKET == f.nativePaneSocket())
		end
	end)

	case("owned PiP pins its executable and socket while endpoint recovery loads replacements", function(f)
		f.config = f.nativeConfig(); f.config.ternExecutable = "/original/Tern CLI/tern"
		f.warm(); f.holdProcesses = true; f.toggle()
		assert(#f.processes == 1 and f.processes[1].argv[1] == "/original/Tern CLI/tern")
		f.config.ternExecutable = "/replacement/Tern CLI/tern"
		f.config.ternPaneSocket = "/replacement/Tern Data/daemon.sock"
		f.tick()
		f.respond(f.take("/v1/state"), { error = "Fixture reconnect" }, 503)
		f.poll()
		f.processReceipt()
		assert(#f.processes == 2 and f.processes[2].argv[1] == "/original/Tern CLI/tern", "in-flight PiP adopted a later connection's executable")
		assert(f.processes[2].options.env.TERN_PANE_SOCKET == f.nativePaneSocket(), "in-flight PiP adopted a later connection's socket")
		f.processReceipt(); f.holdProcesses = false
		assert(f.layout().focus == f.panelPane)
		f.daemonSocket = f.config.ternPaneSocket
		f.toggle(); f.focus(f.original); f.toggle()
		assert(#f.processes == 4 and f.processes[3].argv[1] == "/replacement/Tern CLI/tern" and f.processes[4].argv[1] == "/replacement/Tern CLI/tern", "new PiP ignored the recovered machine-local config")
		assert(f.processes[3].options.env.TERN_PANE_SOCKET == f.daemonSocket and f.processes[4].options.env.TERN_PANE_SOCKET == f.daemonSocket, "new PiP ignored the recovered machine-local socket")
		assert(#f.errors == 0)
	end)

	case("delayed resize receipt is data only and focus uses a fresh callback", function(f)
		f.warm(); f.holdProcesses = true; f.toggle()
		assert(#f.processes == 1 and f.processes[1].verb == "resize" and f.layout().focus == f.original)
		f.processReceipt(nil, true)
		assert(#f.processes == 1 and f.layout().focus == f.original, "resize receipt focused synchronously")
		f.flush()
		assert(#f.processes == 2 and f.processes[2].verb == "focus" and f.layout().focus == f.panelPane)
		f.processReceipt()
		f.poll(); f.flushPanels()
		assert(#f.processes == 2 and #f.resizes == 1 and #f.errors == 0)
	end)

	for _, stage in { "float", "resize", "focus" } do
		for _, change in { "focus", "host", "session", "tab", "closed destination", "foreign destination", "moved destination", "owner destination" } do
			case("automatic PiP cancels after " .. stage .. " on changed " .. change, function(f)
				f.warm()
				local stoppedAt
				local function changeContext()
					if stoppedAt then return end
					stoppedAt = #f.processes
					if change == "focus" then f.focus(f.other)
					elseif change == "host" then f.currentHost = 3
					elseif change == "session" then f.currentSession = 2
					elseif change == "tab" then
						local pane = f.original + 200
						f.addTabPane(pane); f.focus(pane)
					elseif change == "closed destination" then f.invalidateOriginal()
					elseif change == "foreign destination" then f.foreign(f.original)
					elseif change == "moved destination" then f.movePaneToTab(f.original)
					else f.destinationOverride = { [f.original] = "replacement-destination" } end
				end
				if stage == "float" then f.onFloat = changeContext
				else f.onProcess = function(process) if process.verb == stage then changeContext() end end end
				f.toggle()
				assert(stoppedAt and #f.processes == stoppedAt, "PiP continued in a stale destination context")
				assert(f.isOpen(f.panelPane) and #f.closes == 0 and f.tab(f.panelTab) == nil, "post-float cancellation closed the user's PiP or recreated a temporary tab")
				f.poll(); f.flushPanels()
				assert(#f.processes == stoppedAt, "poll restarted stale PiP work")
				if change == "tab" then assert(f.layout().focus == f.original + 200, "initialization returned from the user's selected tab") end
				if change == "focus" then assert(f.layout().focus == f.other, "initialization stole user focus") end
				assert(f.isOpen(f.other) and #f.sent == 0 and #f.native == 0 and #f.actions == 0)
				if change ~= "closed destination" and change ~= "moved destination" then f.assertOriginalTab() end
			end)
		end
	end

	case("late resize receipt cannot revive a cancelled owned panel", function(f)
		f.warm(); f.holdProcesses = true; f.toggle()
		local old = f.panelPane
		f.focus(f.other); f.step()
		f.processReceipt()
		assert(#f.processes == 1 and f.layout().focus == f.other and f.isOpen(old))
		f.focus(old); f.poll(); f.advance(5000); f.poll()
		assert(#f.processes == 1 and #f.resizes == 1, "late receipt or polling restarted cancelled initialization")
	end)

	case("old process receipt cannot initialize a newly reopened panel", function(f)
		f.warm(); f.holdProcesses = true; f.toggle()
		local old = f.panelPane
		f.dispatch("toggle-bridge"); f.flushPanels()
		assert(not f.isOpen(old) and #f.processes == 1)
		f.focus(f.original); f.toggle()
		local replacement = f.panelPane
		assert(replacement ~= old and #f.processes == 1)
		f.processReceipt(nil, true)
		assert(#f.processes == 1 and f.layout().focus == f.original, "old receipt performed work for replacement panel")
		f.flush()
		assert(#f.processes == 2 and f.processes[2].verb == "resize" and f.processes[2].pane == replacement)
		f.processReceipt(); f.processReceipt()
		assert(#f.processes == 3 and #f.resizes == 2 and f.layout().focus == replacement and #f.errors == 0)
	end)

	for _, missing in { "surface", "owner marker", "ordinal", "layout" } do
		case("unavailable floated " .. missing .. " never guesses a PiP target", function(f)
			f.warm(); f.invoke("toggle-bridge")
			f.respond(f.take("/v1/panels/open"), { ok = true }, nil, true)
			if missing == "surface" then f.nativeSurfaceMissing = f.panelPane
			elseif missing == "owner marker" then f.panelSurfaceOwner = "another-window/another-panel"
			elseif missing == "ordinal" then f.missingFloat = true
			else f.layoutError = true end
			for _ = 1, 4 do if #f.floats == 0 then f.step() end end
			assert(#f.floats == 1 and f.isOpen(f.panelPane), "hidden panel was required to render before float")
			f.step() -- Observe the absent surface/layout before expiring any render wait.
			f.advance(10001); f.flush(); f.flushPanels()
			assert(#f.processes == 0 and #f.resizes == 0 and #f.closes == 0 and f.isOpen(f.panelPane))
			assert(#f.errors == (missing == "ordinal" and 0 or 1), "native lookup failure/render timeout was not reported exactly once")
			f.poll(); assert(#f.processes == 0)
			f.assertOriginalTab()
		end)
	end

	case("current-tab ordinal above one ignores SDK IDs and preserves unrelated PiPs", function(f)
		local unrelated = f.original + 300
		f.addFloat(unrelated, f.other)
		local foreign = f.original + 301
		f.addTabPane(foreign); f.addFloat(foreign + 1, foreign)
		f.warm(); f.toggle()
		assert(#f.processes == 2 and f.processes[1].argv[5] == '"#2"' and f.processes[2].argv[5] == '"#2"')
		assert(f.floating(unrelated).size[1] == 315 and f.floating(unrelated).focus_size[2] == 330 and f.floating(unrelated).corner == "bottom_left")
		assert(f.floating(foreign + 1).size[1] == 315 and f.floating(foreign + 1).focus_size[2] == 330)
		f.assertOriginalTab()
	end)

	case("focus recomputes ordinal after resize receipt instead of caching it", function(f)
		local unrelated = f.original + 300
		f.addFloat(unrelated, f.other)
		f.warm(); f.holdProcesses = true; f.toggle()
		assert(f.processes[1].argv[5] == '"#2"')
		f.removeFloat(unrelated)
		f.processReceipt()
		assert(#f.processes == 2 and f.processes[2].argv[5] == '"#1"')
		f.processReceipt()
		assert(f.layout().focus == f.panelPane and #f.resizes == 1)
	end)

	for _, verb in { "resize", "focus" } do
		for _, failure in { "status", "json", "ok", "timeout" } do
			case("native " .. verb .. " " .. failure .. " is reported without retry or cleanup of floated panel", function(f)
				f.warm(); f.holdProcesses = true; f.toggle()
				if verb == "focus" then f.processReceipt() end
				local result = f.processResult(failure == "status" and 1 or 0, failure == "json" and "not-json" or { ok = failure ~= "ok" }, failure == "timeout")
				result.stderr = "private stderr /private/daemon.sock fixture-token"
				f.processReceipt(result)
				local count = #f.processes
				assert(count == (verb == "resize" and 1 or 2) and #f.errors == 1 and f.isOpen(f.panelPane) and #f.closes == 0)
				local evidence
				for _, item in f.logs do
					assert(item.event ~= "panel.pip.ready", "failed native receipt was counted as initialized")
					if item.event == "panel.pip.failed" then assert(not evidence); evidence = item end
				end
				assert(evidence and evidence.exitCode == result.status and evidence.timedOut == (failure == "timeout"))
				assert(evidence.jsonDecoded == (failure ~= "json") and evidence.nativeOk == (failure ~= "json" and failure ~= "ok"))
				assert(evidence.resizing == (verb == "resize"), "receipt diagnostic attributed failure to the wrong phase")
				for key, value in evidence do
					assert(key == "event" or key == "window" or key == "operation" or key == "time" or key == "exitCode" or key == "timedOut" or key == "jsonDecoded" or key == "nativeOk" or key == "resizing", "unapproved receipt diagnostic field")
					if type(value) == "string" then assert(key == "event" or key == "window", "private receipt text entered diagnostics") end
				end
				f.poll(); f.flushPanels(); assert(#f.processes == count, "poll retried an uncertain native outcome")
			end)
		end
	end

	for _, status in { false, "private exit text", -2147483649, 4294967296, 1.5, math.huge, 0 / 0 } do
		case("receipt diagnostics omit invalid or unbounded exit code " .. tostring(status), function(f)
			f.warm(); f.holdProcesses = true; f.toggle()
			f.processReceipt(f.processResult(status, { ok = true }))
			local evidence
			for _, item in f.logs do if item.event == "panel.pip.failed" then evidence = item end end
			assert(evidence and evidence.exitCode == nil and evidence.timedOut == false and evidence.jsonDecoded == true and evidence.nativeOk == true)
			assert(#f.errors == 1 and #f.processes == 1)
		end)
	end

	case("native process launch failure remains visible and never falls back to pane input", function(f)
		f.warm(); f.spawnError = true; f.toggle()
		assert(#f.errors == 1 and #f.processes == 0 and #f.sent == 0 and #f.native == 0 and f.isOpen(f.panelPane))
		f.poll(); f.flushPanels(); assert(#f.errors == 1 and #f.processes == 0)
	end)

	case("missing process receipt expires without retry and late success cannot restart focus", function(f)
		f.warm(); f.holdProcesses = true; f.toggle()
		f.advance(10001); f.step()
		f.processReceipt()
		assert(#f.processes == 1 and #f.errors == 1 and f.layout().focus == f.original and f.isOpen(f.panelPane))
		f.poll(); assert(#f.processes == 1)
	end)


	case("panel upload waits for fresh identity before opening its prompt", function(f)
		f.warm()
		f.toggle()
		f.advance(6000)
		f.link("upload")
		f.noRequest("/v1/captures/pick-file")
		f.resolve(f.take("/v1/intents"), "session-A", "draft-A")
		assert(f.take("/v1/captures/pick-file").timeout > 120000)
		assert(#f.errors == 0)
	end)

	case("panel preparation cannot adopt a replacement conversation", function(f)
		f.warm()
		f.toggle()
		f.advance(6000)
		f.link("upload")
		f.resolve(f.take("/v1/intents"), "session-B", "draft-B")
		assert(#f.errors > 0)
		f.noRequest("/v1/captures/pick-file")
	end)

	for _, verb in { "paste", "upload" } do
		case("private " .. verb .. " route returns handled before surface chooser or HTTP work", function(f)
			f.warm()
			f.toggle()
			local request = f.linkRequest(verb)
			local checks, io = f.surfaceChecks, f.ioCount()
			assert(f.dispatch("link", request).handled == true, "private URL escaped native routing")
			assert(f.surfaceChecks == checks, "route inspected a surface before returning handled")
			assert(#f.picks == 0 and #f.prompts == 0, "route opened a chooser before returning handled")
			assert(f.ioCount() == io, "route performed IO before returning handled")
			-- The host may reuse its request table after return. Deferred work must
			-- retain the original URL and pane, and use a fresh callback context.
			request.url, request.pane = f.linkRequest("hide").url, f.other
			f.flush()
			assert(f.surfaceChecks > checks, "deferred action skipped panel surface validation")
			f.noRequest("/v1/panels/close")
			if verb == "paste" then
				assert(#f.picks == 0 and #f.prompts == 0, "explicit paste opened a source chooser")
				f.respond(f.take("/v1/captures/clipboard"), { kind = "text", text = "deferred panel paste" })
				local resolve = f.take("/v1/intents", f.viewId)
				assert(resolve.body.destinationId == "destination-A", "deferred paste retargeted another pane")
				f.resolve(resolve, "session-A", "draft-A")
				local pasted = f.pasted()
				assert(#pasted == 1 and pasted[1].viewId == f.viewId and pasted[1].sessionId == "session-A" and pasted[1].draftToken == "draft-A")
			else
				assert(#f.picks == 0 and #f.prompts == 0)
				local capture = f.take("/v1/captures/pick-file")
				local resolve = f.capture(capture, "deferred-panel-file")
				assert(resolve.body.destinationId == "destination-A", "deferred upload retargeted another pane")
				f.resolve(resolve, "session-A", "draft-A")
				local upload = f.take("/v1/transfers")
				assert(upload.body.viewId == f.viewId and upload.body.expectedSessionId == "session-A" and upload.body.expectedDraftToken == "draft-A")
			end
			assert(#f.errors == 0 and #f.native == 0 and #f.sent == 0)
		end)
	end

	for _, change in { "focus", "panel surface", "closed panel" } do
		case("deferred panel action rejects changed " .. change, function(f)
			f.warm()
			f.toggle()
			assert(f.dispatch("link", f.linkRequest("paste")).handled == true)
			assert(#f.picks == 0 and #f.errors == 0)
			if change == "focus" then f.focus(f.other)
			elseif change == "panel surface" then f.nativeSurfaceMissing = f.panelPane
			else f.dispatch("toggle-bridge") end -- Close before the queued route runs.
			local io = f.ioCount()
			f.flush()
			assert(#f.errors == 1 and f.errors[1]:find("stale", 1, true), "deferred action accepted a changed panel")
			assert(#f.picks == 0 and #f.prompts == 0 and f.ioCount() == io)
			f.noRequest("/v1/captures/clipboard")
			f.noRequest("/v1/captures/pick-file")
			f.noRequest("/v1/intents")
			assert(#f.native == 0 and #f.sent == 0)
		end)
	end

	for _, replacement in { { "session-B", "draft-A" }, { "session-A", "draft-B" } } do
		case("deferred upload rejects changed target " .. replacement[1] .. "/" .. replacement[2], function(f)
			f.warm()
			f.toggle()
			f.advance(6000)
			local checks, io = f.surfaceChecks, f.ioCount()
			assert(f.dispatch("link", f.linkRequest("upload")).handled == true)
			assert(f.surfaceChecks == checks and f.ioCount() == io and #f.picks == 0 and #f.prompts == 0)
			f.flush()
			assert(f.surfaceChecks > checks, "deferred upload skipped panel validation")
			local resolve = f.take("/v1/intents", f.viewId)
			assert(resolve.body.destinationId == "destination-A", "deferred validation did not retain the original target")
			f.noRequest("/v1/captures/pick-file")
			f.resolve(resolve, replacement[1], replacement[2])
			assert(#f.errors == 1 and f.errors[1]:find("changed", 1, true))
			assert(#f.picks == 0 and #f.prompts == 0 and #f.native == 0 and #f.sent == 0)
			f.noRequest("/v1/captures/pick-file")
			f.noRequest("/v1/captures/clipboard")
			f.noRequest("/v1/transfers")
		end)
	end

	case("foreign stale malformed and wrong-origin panel links have no side effects", function(f)
		f.warm()
		f.toggle()
		local before = f.ioCount()
		assert(f.link("paste", f.original).handled)
		assert(f.link("paste", nil, "another-window").handled)
		assert(f.link("paste", nil, nil, "old-panel").handled)
		assert(f.link("unknown").handled)
		assert(f.invoke("link", { pane = f.panelPane, url = "omp-bridge-panel://invalid" }).handled)
		assert(f.invoke("link", { pane = f.panelPane, url = "https://example.invalid/" }) == nil)
		assert(f.invoke("link", { pane = f.panelPane, url = "omp-bridge-panel-other://x/y/paste" }) == nil)
		assert(f.ioCount() == before and #f.picks == 0 and #f.prompts == 0)
		local args = f.creations[1].launch.args
		local oldPane = f.panelPane
		f.toggle()
		assert(f.invoke("link", { pane = oldPane, url = "omp-bridge-panel://" .. args[1] .. "/" .. args[2] .. "/paste" }).handled)
	end)

	case("reload never adopts or closes an older window panel", function(f)
		f.warm()
		f.toggle()
		local oldPane, args = f.panelPane, f.creations[1].launch.args
		f.reload()
		local before = f.ioCount()
		assert(f.invoke("link", { pane = oldPane, url = "omp-bridge-panel://" .. args[1] .. "/" .. args[2] .. "/upload" }).handled)
		assert(f.ioCount() == before and #f.prompts == 0 and #f.closes == 0)
	end)

	case("hiding Bridge during file capture preserves transfer and pinned draft", function(f)
		f.warm()
		f.toggle()
		f.focus(f.panelPane)
		assert(f.link("upload").handled)
		local capture = f.take("/v1/captures/pick-file")
		f.link("hide")
		f.noRequest("/v1/transfers/cancel")
		f.resolve(f.capture(capture, "hidden-file"), "session-A", "draft-A")
		local upload = f.take("/v1/transfers")
		assert(upload.body.viewId == f.viewId and upload.body.expectedSessionId == "session-A")
		f.respond(upload, { id = "hidden-transfer", phase = "uploading" })
		f.ready("hidden-transfer", "hidden-panel-attachment")
		assert(#f.sent == 0, "hidden panel replayed an attachment")
		f.noRequest("/v1/transfers/cancel")
	end)

	case("panel upload refuses replacement conversation while system picker waits", function(f)
		f.warm()
		f.toggle()
		f.link("upload")
		f.focus(f.other)
		f.resolve(f.capture(f.take("/v1/captures/pick-file"), "stale-panel-file"), "session-B", "draft-B")
		f.released("stale-panel-file")
		f.noRequest("/v1/transfers")
		assert(#f.errors > 0)
	end)


	case("missing host block closes only the prepared panel record", function(f)
		f.warm()
		f.missingHostBlock = true
		f.toggle()
		assert(#f.errors == 1 and #f.resizes == 0 and #f.closes == 0)
		assert(f.status()[1].text == "Needs attention", "host panel failure lost its error status")
		assert(f.isOpen(f.original) and f.isOpen(f.other))
	end)

	case("unavailable remote agent surface never falls back to another pane or sends input", function(f)
		f.warm()
		local sent = #f.sent
		f.nativeSurfaceMissing = f.original
		f.toggle()
		assert(#f.creations == 0 and #f.errors == 0 and #f.sent == sent and #f.closes == 0)
		assert(#f.toasts == 1 and f.toasts[1].level == "info")
		assert(f.status()[1].text == "Connected · Unbound")
		f.nativeSurfaceMissing = false
		f.toggle()
		assert(#f.creations == 1 and #f.sent == sent)
		assert(f.latestSnapshot().error == nil, "unavailable surface poisoned the recovered panel")
	end)

	case("closed owned panel invalidates links and can be recreated", function(f)
		f.warm()
		f.toggle()
		local old = f.panelPane
		f.closePanel()
		assert(f.link("paste", old).handled)
		f.noRequest("/v1/captures/clipboard")
		f.toggle()
		assert(f.panelPane ~= old and #f.closes == 0)
	end)

	case("panel snapshots are bounded public data and heartbeat never resizes", function(f)
		f.warm()
		f.toggle()
		local resizes, actions = #f.resizes, #f.actions
		local items = {}
		for index = 1, 25 do table.insert(items, { id = "transfer-" .. index, viewId = f.viewId, phase = "failed", names = { string.rep("x", 300) }, bytesSent = 0, totalBytes = 9, error = "fixture-token http://127.0.0.1:9999 private clipboard" }) end
		f.setTransfers(items)
		local snapshot = f.latestSnapshot()
		assert(#snapshot.transfers == 20 and #snapshot.transfers[1].name <= 240)
		assert(not snapshot.transfers[1].error:find("fixture-token", 1, true))
		assert(snapshot.token == nil and snapshot.endpoint == nil and snapshot.views == nil and snapshot.draftToken == nil)
		local count = #f.snapshots
		f.poll()
		f.flushPanels(); assert(#f.snapshots == count)
		f.advance(5000)
		f.poll()
		f.flushPanels(); assert(#f.snapshots == count + 1 and #f.resizes == resizes and #f.actions == actions)
	end)

	case("panel focus preserves eligible destination and device picker rejects later conversation", function(f)
		f.warm()
		f.toggle()
		f.focus(f.panelPane)
		f.invoke("focus", {})
		f.noRequest("/v1/intents")
		assert(f.link("devices").handled)
		f.resolve(f.take("/v1/intents", f.viewId), "session-A", "draft-A")
		f.choose("label", "Unbound")
		f.resolve(f.take("/v1/intents", f.viewId), "session-B", "draft-B")
		f.noRequest("/v1/intents")
		assert(#f.errors > 0, "device picker adopted a different conversation")
	end)

	case("panel transfer list does not open an empty picker for another target's uploads", function(f)
		f.warm()
		f.toggle()
		f.setTransfers({ { id = "other-upload", viewId = "another-view", phase = "uploading", names = { "other.txt" }, bytesSent = 1, totalBytes = 2 } })
		assert(f.link("transfers").handled)
		assert(#f.picks == 0)
		f.noRequest("/v1/transfers/cancel")
	end)

	case("panel approvals and transfers reuse local native flows", function(f)
		f.warm()
		f.toggle()
		f.approval("device-approval")
		assert(f.link("approvals").handled)
		assert(#f.picks == 1)
		f.choose(nil)
		assert(f.take("/v1/interactions/reply").body.id == "device-approval")
		f.setTransfers({
			{ id = "own", viewId = f.viewId, phase = "uploading", names = { "own.txt" }, bytesSent = 1, totalBytes = 9 },
			{ id = "foreign", viewId = "other-window", phase = "uploading", names = { "foreign.txt" }, bytesSent = 1, totalBytes = 9 },
		})
		assert(f.link("transfers").handled)
		assert(#f.picks[1].options.items == 1 and f.picks[1].options.items[1].transfer.id == "own")
		f.choose(nil)
		f.noRequest("/v1/transfers/cancel")
	end)

	case("closed original target never follows another pane from panel", function(f)
		f.warm()
		f.toggle()
		f.closeOriginal()
		local before = f.ioCount()
		assert(f.link("paste").handled)
		f.noRequest("/v1/captures/clipboard")
		assert(#f.picks == 0)
	end)

	case("ordinary native routing remains outside bridge scope", function(f)
		f.remote(false)
		assert(f.drop() == nil)
		assert(f.invoke("drop", { origin = "files", host = "local", path = "/synthetic/file.txt" }) == nil)
		assert(f.invoke("drop", { origin = "drop", host = "agent", path = "/synthetic/file.txt" }) == nil)
		f.noRequest("/v1/captures")
		f.chromeIsPure()
	end)

	case("explicit paste captures once and retains the original destination without a second dialog", function(f)
		f.warm()
		local capture = f.clipboard()
		f.invoke("paste-remote")
		assert(#f.picks == 0 and #f.prompts == 0, "explicit paste opened a redundant dialog")
		f.noRequest("/v1/captures/clipboard")
		f.focus(f.other)
		f.resolve(f.capture(capture, "image-snapshot"), "session-A", "draft-A")
		local upload = f.take("/v1/transfers")
		assert(upload.body.captureId == "image-snapshot" and upload.body.expectedSessionId == "session-A" and upload.body.expectedDraftToken == "draft-A")
		assert(#f.native == 0 and #f.pasted() == 0, "image command added text or replayed native paste")
		f.chromeIsPure()
	end)


	case("direct upload opens one system chooser and cancellation has no transfer side effects", function(f)
		f.warm()
		f.invoke("upload-file")
		local capture = f.take("/v1/captures/pick-file")
		assert(#f.picks == 0 and #f.prompts == 0)
		f.invoke("upload-file")
		f.noRequest("/v1/captures/pick-file")
		f.noRequest("/v1/captures/clipboard")
		f.noRequest("/v1/captures")
		f.respond(capture, { cancelled = true })
		f.noRequest("/v1/transfers")
		f.noRequest("/v1/intents")
		assert(#f.errors == 0 and #f.pasted() == 0)
	end)

	case("system file selection retains the destination pinned before picker", function(f)
		f.warm()
		f.invoke("upload-file")
		f.focus(f.other)
		local capture = f.take("/v1/captures/pick-file")
		f.noRequest("/v1/captures/clipboard")
		f.resolve(f.capture(capture, "chosen-file"), "session-A", "draft-A")
		local upload = f.take("/v1/transfers")
		assert(upload.body.viewId == f.viewId and upload.body.expectedSessionId == "session-A" and upload.body.expectedDraftToken == "draft-A")
	end)


	case("multiline Unicode clipboard text pins a directed native paste without file classification", function(f)
		f.warm()
		f.invoke("paste-remote")
		f.focus(f.other)
		local text = "/synthetic/image.png\n你好\t$(not a shell)\r\n"
		f.respond(f.take("/v1/captures/clipboard"), { kind = "text", text = text })
		f.resolve(f.take("/v1/intents", f.viewId), "session-A", "draft-A")
		local pasted = f.pasted()
		assert(#pasted == 1 and pasted[1].viewId == f.viewId and pasted[1].sessionId == "session-A" and pasted[1].draftToken == "draft-A" and pasted[1].text == text)
		f.noRequest("/v1/captures")
		f.noRequest("/v1/transfers")
		assert(#f.native == 0, "clipboard was read again via native paste")
	end)

	for _, replacement in { { "session-A", "draft-B" }, { "session-B", "draft-A" } } do
		case("clipboard text rejects stale destination " .. replacement[1] .. "/" .. replacement[2], function(f)
			f.warm()
			f.invoke("paste-remote")
			f.mutateCachedIdentity(replacement[1], replacement[2])
			f.respond(f.take("/v1/captures/clipboard"), { kind = "text", text = "never retarget" })
			f.resolve(f.take("/v1/intents", f.viewId), replacement[1], replacement[2])
			assert(#f.pasted() == 0 and #f.errors > 0)
			f.noRequest("/v1/transfers")
		end)
	end

	for _, text in { "\27[201~run\r", "\3", "\0", "\127", utf8.char(155) .. "201~" } do
		case("clipboard terminal controls never reach native input " .. string.byte(text), function(f)
			f.warm()
			f.respond(f.clipboard(), { kind = "text", text = text })
			assert(#f.pasted() == 0 and #f.errors == 1)
			f.noRequest("/v1/intents")
			f.noRequest("/v1/transfers")
		end)
	end


	case("closing destination during clipboard capture cancels and ignores late text", function(f)
		f.warm()
		local capture = f.clipboard()
		f.closeOriginal()
		f.respond(capture, { kind = "text", text = "late clipboard" })
		assert(#f.pasted() == 0)
		f.noRequest("/v1/transfers")
	end)

	case("transfer status weights bytes and does not invent unknown progress", function(f)
		f.warm()
		f.setTransfers({
			{ id = "small", phase = "uploading", bytesSent = 10, totalBytes = 10 },
			{ id = "large", phase = "uploading", bytesSent = 15, totalBytes = 90 },
		})
		local progress = f.status()[2]
		assert(progress.text:find("25%", 1, true), "progress must weight bytes, not average file percentages")
		assert(progress.command == "plugin.omp-client-bridge.transfers")
		print("TRANSFER " .. progress.text)
		f.setTransfers({ { id = "unknown", phase = "uploading", bytesSent = 40, totalBytes = 0 } })
		assert(not f.status()[2].text:find("%", 1, true), "unknown totals produced a percentage")
		f.connected(false)
		f.poll()
		assert(f.status()[2].tone == "warn")
		print("TRANSFER " .. f.status()[2].text)
		f.chromeIsPure()
	end)

	case("transfer completion is observed once and expires without replaying history", function(f)
		f.warm()
		f.setTransfers({ { id = "old", phase = "attached", bytesSent = 10, totalBytes = 10 } })
		assert(#f.status() == 1, "historical completion was announced as new")
		f.setTransfers({ { id = "live", phase = "captured", bytesSent = 0, totalBytes = 10 } })
		local preparing = f.status()[2].text
		print("TRANSFER " .. preparing)
		f.setTransfers({ { id = "live", phase = "ready", bytesSent = 10, totalBytes = 10 } })
		assert(f.status()[2].text ~= preparing and f.status()[2].tone ~= "ok")
		print("TRANSFER " .. f.status()[2].text)
		f.setTransfers({ { id = "live", phase = "attached", bytesSent = 10, totalBytes = 10 } })
		assert(f.status()[2].tone == "ok")
		print("TRANSFER " .. f.status()[2].text)
		f.advance(5001)
		f.poll()
		assert(#f.status() == 1, "completion persisted or was refreshed by an unchanged snapshot")
		f.setTransfers({ { id = "failed", phase = "failed", bytesSent = 5, totalBytes = 10 } })
		assert(f.status()[2].tone == "error")
		print("TRANSFER " .. f.status()[2].text)
	end)

	case("status stays compact and detailed transfers remain in native picker", function(f)
		f.warm()
		f.setTransfers({
			{ id = "done", viewId = f.viewId, phase = "attached", names = { "done.txt" }, bytesSent = 9, totalBytes = 9 },
			{ id = "active", viewId = f.viewId, phase = "uploading", names = { "active.txt" }, bytesSent = 3, totalBytes = 9 },
			{ id = "failed", viewId = f.viewId, phase = "failed", names = { "failed.txt" }, bytesSent = 1, totalBytes = 9, error = "offline" },
		})
		f.invoke("transfers")
		assert(#f.picks[1].options.items == 3 and f.picks[1].options.items[1].detail == "Handed to OMP · 9/9 bytes")
		f.choose(nil)
		f.noRequest("/v1/transfers/cancel")
		f.setTransfers({ { id = "done", viewId = f.viewId, phase = "attached", names = { "done.txt" }, bytesSent = 9, totalBytes = 9 } })
		f.chromeIsPure()
	end)

	case("cold explicit paste waits for destination resolution before one capture", function(f)
		f.poll()
		f.invoke("paste-remote")
		assert(#f.picks == 0 and #f.prompts == 0 and #f.errors == 0)
		f.noRequest("/v1/captures/clipboard")
		f.noRequest("/v1/captures")
		local request = f.take("/v1/intents")
		f.viewId = request.body.viewId
		f.resolve(request, "session-A", "draft-A")
		f.take("/v1/captures/clipboard")
		f.noRequest("/v1/captures/clipboard")
		f.noRequest("/v1/captures")
		assert(#f.picks == 0 and #f.prompts == 0)
	end)

	case("system picker cannot adopt a draft changed while open", function(f)
		f.warm()
		f.invoke("upload-file")
		f.mutateCachedIdentity("session-A", "draft-after-submit")
		f.resolve(f.capture(f.take("/v1/captures/pick-file"), "stale-choice"), "session-A", "draft-after-submit")
		f.noRequest("/v1/transfers")
		f.released("stale-choice")
		assert(#f.errors == 1)
	end)

	case("closed destination releases system-selected capture without uploading", function(f)
		f.warm()
		f.invoke("upload-file")
		f.closeOriginal()
		f.respond(f.take("/v1/captures/pick-file"), { id = "closed-choice", kind = "files", names = { "file.txt" } })
		f.released("closed-choice")
		f.noRequest("/v1/transfers")
		assert(#f.errors == 1)
	end)

	case("closing the destination releases a late clipboard image without attachment", function(f)
		f.warm()
		local capture = f.clipboard()
		f.closeOriginal()
		f.respond(capture, { kind = "files", id = "late-image", names = { "clipboard.png" } })
		f.released("late-image")
		f.noRequest("/v1/transfers")
		assert(#f.pasted() == 0 and #f.errors == 0)
	end)


	case("terminal retaining an OMP surface is not an active destination", function(f)
		f.surface("omp.session", "terminal")
		assert(f.invoke("drop", { origin = "drop", host = "local", path = "/synthetic/file.txt" }) == nil)
		f.noRequest("/v1/intents")
		f.noRequest("/v1/captures")
	end)

	case("cold drop is consumed, and retry retains exact ordinary-file path", function(f)
		f.poll()
		local drop = { origin = "drop", host = "local", path = "/synthetic/图 one.txt" }
		assert(f.invoke("drop", drop).handled == true)
		f.noRequest("/v1/captures")
		assert(#f.errors > 0, "unresolved drop failed silently")
		local request = f.take("/v1/intents")
		f.viewId = request.body.viewId
		f.resolve(request, "session-A", "draft-A")
		assert(f.invoke("drop", drop).handled == true)
		local capture = f.take("/v1/captures")
		assert(capture.body.kind == "files" and capture.body.paths[1] == drop.path)
		f.resolve(f.capture(capture, "dropped-file"), "session-A", "draft-A")
		local upload = f.take("/v1/transfers")
		assert(upload.body.captureId == "dropped-file" and upload.body.expectedSessionId == "session-A" and upload.body.expectedDraftToken == "draft-A")
	end)

	case("overlapping drops keep both files in their original unchanged draft", function(f)
		f.warm()
		assert(f.invoke("drop", { origin = "drop", host = "local", path = "/synthetic/one.txt" }).handled)
		local first = f.take("/v1/captures")
		assert(f.invoke("drop", { origin = "drop", host = "local", path = "/synthetic/two.txt" }).handled)
		local second = f.take("/v1/captures")
		f.respond(first, { id = "first-file", kind = "files", names = { "one.txt" } })
		f.respond(second, { id = "second-file", kind = "files", names = { "two.txt" } })
		local attempts = 0
		while f.hasRequest("/v1/intents") do
			attempts += 1
			assert(attempts <= 4, "unchanged drop validation did not settle")
			f.resolve(f.take("/v1/intents"), "session-A", "draft-A")
		end
		assert(#f.errors == 0, "an overlapping drop cancelled an unchanged destination")
		f.noRequest("/v1/captures/release")
		local captures = {}
		for _ = 1, 2 do
			local upload = f.take("/v1/transfers")
			assert(upload.body.expectedSessionId == "session-A" and upload.body.expectedDraftToken == "draft-A")
			captures[upload.body.captureId] = true
		end
		assert(captures["first-file"] and captures["second-file"], "one selected file was lost")
	end)

	for _, replacement in { { "session-A", "draft-after-submit" }, { "session-B", "draft-A" } } do
		case("files reject same-pane replacement " .. replacement[1] .. "/" .. replacement[2], function(f)
			f.warm()
			local capture = f.captureDrop()
			-- Later polling/consumers cannot mutate the gesture's original identity.
			f.mutateCachedIdentity(replacement[1], replacement[2])
			local validate = f.capture(capture, "changed-capture")
			f.resolve(validate, replacement[1], replacement[2])
			f.noRequest("/v1/transfers")
			assert(#f.native == 0, "file transfer triggered native paste")
			assert(#f.errors > 0, "replacement draft rejection was silent")
			f.released("changed-capture")
		end)
	end

	case("unchanged file retains captured destination across focus and polling without pane input", function(f)
		f.warm()
		local capture = f.captureDrop()
		f.focus(f.other)
		local validate = f.capture(capture, "owned-file")
		local receipt = f.resolve(validate, "session-A", "draft-A")
		local upload = f.take("/v1/transfers")
		assert(upload.body.viewId == f.viewId and upload.body.captureId == "owned-file")
		assert(upload.body.expectedSessionId == "session-A" and upload.body.expectedDraftToken == "draft-A")
		assert(upload.body.expectedResolveIntentId == receipt, "transfer lacks the validating receipt")
		f.respond(upload, { id = "transfer-file", phase = "uploading" })
		f.ready("transfer-file", "opaque-attachment")
		f.poll()
		assert(#f.sent == 0, "window replayed a broker-delivered attachment")
		assert(#f.native == 0, "file attachment triggered native paste")
		f.chromeIsPure()
	end)

	case("polling a replacement while capture waits cannot retarget that capture", function(f)
		f.warm()
		local capture = f.captureDrop()
		f.invoke("focus", {})
		f.resolve(f.take("/v1/intents"), "session-B", "draft-B")
		local validate = f.capture(capture, "polling-race")
		f.resolve(validate, "session-B", "draft-B")
		f.noRequest("/v1/transfers")
		f.released("polling-race")
		assert(#f.native == 0 and #f.errors > 0)
	end)

	case("closed original pane releases captured files instead of retargeting", function(f)
		f.warm()
		local capture = f.captureDrop()
		f.closeOriginal()
		local validate = f.capture(capture, "closed-capture")
		f.receipt(validate) -- actual plugin send checks the now-closed original pane
		f.released("closed-capture")
		f.noRequest("/v1/transfers")
		assert(#f.errors > 0)
	end)

	case("capture failure leaves native input untouched and permits another gesture", function(f)
		f.warm()
		f.respond(f.captureDrop(), { error = "Fixture source became unreadable" }, 400)
		f.noRequest("/v1/transfers")
		assert(#f.native == 0 and #f.errors > 0)
		f.resolve(f.capture(f.captureDrop(), "retry-after-capture-error"), "session-A", "draft-A")
		assert(f.take("/v1/transfers").body.captureId == "retry-after-capture-error")
		assert(#f.native == 0)
	end)

	case("in-flight and failed refresh cannot lend scheduling freshness to old cached view", function(f)
		f.warm()
		f.invoke("focus", {})
		local refresh = f.take("/v1/intents")
		assert(f.drop().handled == true)
		f.noRequest("/v1/captures")
		f.respond(refresh, { error = "Fixture resolve request failed" }, 503)
		assert(f.drop().handled == true)
		f.noRequest("/v1/captures")
		local retry = f.take("/v1/intents")
		f.resolve(retry, "session-A", "draft-A")
		f.noRequest("/v1/captures")
		f.captureDrop() -- only an explicit gesture after a successful receipt captures
	end)

	case("expired successful resolution requires a new matching receipt", function(f)
		f.warm()
		f.advance(5001)
		assert(f.drop().handled == true)
		f.noRequest("/v1/captures")
		local refresh = f.take("/v1/intents")
		local receipt = f.receipt(refresh)
		f.poll() -- still returns the previous successful receipt
		assert(f.drop().handled == true)
		f.noRequest("/v1/captures")
		f.publish(refresh, receipt, "session-A", "draft-A")
		f.captureDrop()
	end)

	case("disconnect invalidates shared drop validation and releases every capture", function(f)
		f.warm()
		assert(f.invoke("drop", { origin = "drop", host = "local", path = "/synthetic/one.txt" }).handled)
		local first = f.take("/v1/captures")
		assert(f.invoke("drop", { origin = "drop", host = "local", path = "/synthetic/two.txt" }).handled)
		local second = f.take("/v1/captures")
		f.respond(first, { id = "lost-first", kind = "files", names = { "one.txt" } })
		f.respond(second, { id = "lost-second", kind = "files", names = { "two.txt" } })
		local validate = f.take("/v1/intents")
		f.connected(false)
		f.poll()
		f.connected(true)
		f.poll()
		f.receipt(validate)
		f.noRequest("/v1/transfers")
		local released = {}
		for _ = 1, 2 do
			local request = f.take("/v1/captures/release")
			released[request.body.id] = true
			f.respond(request, { ok = true })
		end
		assert(released["lost-first"] and released["lost-second"], "disconnect stranded a selected file")
		f.poll()
		f.noRequest("/v1/captures/release")
		assert(f.drop().handled)
		f.noRequest("/v1/captures")
		f.resolve(f.take("/v1/intents"), "session-A", "draft-A")
		f.captureDrop()
	end)

	case("timed-out handshake cannot become fresh from a late state snapshot", function(f)
		f.warm()
		f.invoke("focus", {})
		local timedOut = f.take("/v1/intents")
		local receipt = f.receipt(timedOut)
		f.advance(10001)
		f.poll()
		f.publish(timedOut, receipt, "session-A", "draft-A")
		assert(f.drop().handled == true)
		f.noRequest("/v1/captures")
	end)

	case("disconnect during clipboard capture keeps polling and rejects late bytes", function(f)
		f.warm()
		local capture = f.clipboard()
		f.connected(false); f.poll()
		f.respond(capture, { kind = "text", text = "must not paste" })
		assert(#f.pasted() == 0)
		f.advance(6000); f.connected(true); f.poll()
		assert(f.hasRequest("/v1/intents"), "disconnection killed the poll loop")
	end)

	case("complete panel target labels remain bounded after title and directory composition", function(f)
		f.paneTitle, f.paneCwd = string.rep("界", 90), "/work/" .. string.rep("x", 230)
		f.warm(); f.toggle()
		local snapshot = f.latestSnapshot()
		assert(#snapshot.target <= 240 and utf8.len(snapshot.target) ~= nil)
	end)

	case("directed paste completion failure is surfaced once without replay", function(f)
		f.warm()
		f.respond(f.clipboard(), { kind = "text", text = "typed once" })
		f.resolve(f.take("/v1/intents", f.viewId), "session-A", "draft-A")
		local paste = f.take("/v1/intents", f.viewId)
		assert(paste.body.kind == "paste")
		f.respond(paste, { id = "paste-failed", expiresAt = 60000 })
		f.outcomes({ { id = "paste-failed", viewId = f.viewId, kind = "paste", error = "Original draft rejected paste" } })
		assert(#f.errors == 1 and f.errors[1] == "Original draft rejected paste")
		f.poll(); assert(#f.errors == 1 and #f.sent == 0)
		f.noRequest("/v1/intents")
	end)

	case("binding admission includes the draft pinned before device selection", function(f)
		f.warm(); f.invoke("devices")
		f.resolve(f.take("/v1/intents", f.viewId), "session-A", "draft-A")
		f.choose("label", "Unbound")
		f.resolve(f.take("/v1/intents", f.viewId), "session-A", "draft-A")
		local bind = f.take("/v1/intents", f.viewId)
		assert(bind.body.kind == "bind" and bind.body.draftToken == "draft-A")
	end)

	print("PASS: " .. tostring(passed) .. " synthetic SDK-boundary cases executing shipped window.luau; native Tern/clipboard/editor acceptance remains separate")
end
