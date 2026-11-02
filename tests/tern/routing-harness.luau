-- SPDX-License-Identifier: MPL-2.0
-- Synthetic SDK boundary executing the actual shipped window.luau in Luau.
-- This is NOT native Tern, physical clipboard, editor, transport, or platform acceptance.
-- The fixture controls async receipts and fresh callback contexts, never copies the router.
function run(entry, loadModule)
	local passed = 0
	local function fixture()
		local handlers, timers, requests, encoded = {}, {}, {}, {}
		local deferred, inReceipt = {}, false
		local inProcessReceipt = false
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
		f.creations, f.closes, f.snapshots = {}, {}, {}
		f.actions, f.floats, f.focuses = {}, {}, {}
		f.processes = {}
		f.writes = {}
		f.logs = {}
		f.deviceEvents = {}
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
				sessions = { current = function() live(); return { id = f.currentSession or 1, host = f.currentHost or 2 } end },
				session = {
					focused = function() live(); return focused end,
					panes = function()
						live()
						local panes = {}
						for pane in opened do
							local tabId = paneTabs[pane]
							table.insert(panes, { pane = pane, program = "zsh", tab = tabId, floating = floatingPane(tabs[tabId], pane) ~= nil, kind = blocks[pane] and (blocks[pane].kind or "plugin") or paneKind, block = blocks[pane] and blocks[pane].block, at_prompt = true })
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
						assert(tabId ~= nil, "layout inspection requires an explicit tab")
						if f.layoutError then error("native layout unavailable") end
						local result = copy(tabs[tabId])
						if f.missingFloat then result.floats = {} end
						return result
					end,
					event = function(_, pane, ev)
						live()
						assert(not inReceipt, "device publication must use a fresh deferred window context")
						local block = assert(blocks[pane], "native event targeted a missing panel")
						assert(opened[pane] and block.block == "omp-client-bridge.panel", "native event targeted another block")
						assert(ev.ev == "action" and ev.act == "bridge-device-selection" and type(ev.value) == "string")
						local value = copy(assert(encoded[ev.value], "native event omitted JSON encoding"))
						assert(value.owner == block.args[1] and value.panelId == block.args[2], "native event crossed panel ownership")
						if f.eventError then error("native event unavailable") end
						table.insert(f.deviceEvents, { pane = pane, event = copy(ev), value = value, at = clock })
					end,
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
					assert(type(reveal.size) == "table" and #reveal.size == 2, "float must supply initial native size")
					for _, dimension in reveal.size do assert(type(dimension) == "number" and dimension > 0, "invalid native size") end
					table.insert(f.floats, { pane = pane, owner = owner, sourceTab = paneTabs[pane], targetTab = paneTabs[owner] })
					-- Native false/throw results leave both source and target trees intact.
					if f.floatError then error("native float unavailable") end
					if f.floatFalse then return false end
					local targetTab = paneTabs[owner]
					detachPane(pane)
					paneTabs[pane] = targetTab
					-- Synthetic cell geometry: preserve independent glance/focus sizes,
					-- with a larger focused view and frame clamping. The metric and growth
					-- factor here are not pixel/default-size acceptance for native Tern.
					local frame = { 100, 60 }
					local size, focusSize = {}, {}
					for axis, dimension in reveal.size do
						size[axis] = math.min(dimension <= 1 and dimension * frame[axis] or dimension, frame[axis])
						focusSize[axis] = math.min(size[axis] * 1.5, frame[axis])
					end
					table.insert(tabs[targetTab].floats, { pane = pane, over = owner, corner = "top_right", size = size, focus_size = focusSize })
					if f.onFloat then f.onFloat(pane, owner) end
					return true
				end, focus = function(_, pane)
					live()
					assert(not inReceipt, "focus must use a fresh native callback, not an HTTP receipt")
					assert(opened[pane], "native focus requires an existing exact pane")
					table.insert(f.focuses, pane)
					if f.focusError then error("native focus unavailable: private host detail") end
					if not f.delayFocus then focused = pane end
					if f.onFocus then f.onFocus(pane) end
					-- Native focus returns no success boolean. A later context observes it.
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
				assert(not inProcessReceipt, "process callback parsed JSON before a fresh timer")
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
				assert(not inProcessReceipt, "process callback performed filesystem IO")
				table.insert(f.reads, path)
				if path == "/isolated/plugin-data/setup-state.json" then return encode(assert(f.setupProgress, "no setup state")) end
				if path == "/isolated/plugin-data/client-resume.json" then
					if f.resumeReadError then error(f.resumeReadError) end
					if not f.resumePlan then error("ENOENT") end
					return f.resumeMalformed and "invalid-json" or encode(f.resumePlan)
				end
				if f.missingConnection then error("No such file or directory (os error 2)") end
				if path == "/isolated/plugin-data/config.json" then
					if f.configReadError then error(f.configReadError) end
					return encode(f.config or { controlFile = "/isolated/client.json" })
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
				assert(not inProcessReceipt, "process callback launched another process")
				if f.processStartError then error("private process failure") end
				table.insert(f.processes, { argv = copy(argv), options = copy(options), callback = callback })
			end },
			timer = function(ms, callback)
				assert(not inProcessReceipt, "process callback scheduled native work")
				deferredDelays[callback] = ms
				table.insert(ms > 0 and ms <= 16 and deferred or timers, callback)
			end,
			sleep = function(_ms)
				return { next = function(_, callback)
					table.insert(deferred, function(cx) callback(nil, nil, cx) end)
				end }
			end,
			chrome = { refresh = function() assert(not inProcessReceipt, "process callback refreshed chrome") end, status = function(callback) handlers.status = callback end },
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
		function f.untilState(predicate)
			for _ = 1, 20 do if predicate() then return end; f.tick() end
			assert(predicate(), "lifecycle did not reach expected state")
		end
		function f.authorizeResume()
			f.resumePlan = { schema = 1, kind = "client-resume", host = "agent", remoteCommand = "bridge relay",
				stateDir = "/isolated", controlFile = "/isolated/client.json", packageRoot = "/approved/package with spaces",
				runtime = "/approved/bun", deviceId = "device-fixture", packageDigest = string.rep("a", 64) }
		end
		function f.finishResume(result)
			local process = assert(f.processes[#f.processes], "resume process missing")
			local before = ioCount
			inProcessReceipt = true
			process.callback(result or { status = 0, stdout = encode({ kind = "client-resumed", stateDir = "/isolated",
				controlFile = "/isolated/client.json", deviceId = "device-fixture", pid = 123, reused = false,
				ownership = "managed", connected = true, sessionReady = false, upgradeRequired = false }), timed_out = false })
			inProcessReceipt = false
			assert(ioCount == before, "process callback performed IO")
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
		function f.binding(id, devices, revision)
			local view = assert(ui.views[f.viewId])
			view.state.binding.clientId = id or null
			view.state.binding.revision = revision or view.state.binding.revision
			view.state.devices = copy(devices)
			f.poll()
		end
		function f.binds()
			local result = {}
			for _, request in requests do if request.path == "/v1/intents" and request.body.kind == "bind" then table.insert(result, request.body) end end
			return result
		end
		function f.choices() return assert(f.deviceEvents[#f.deviceEvents], "native device choices were not delivered").value end
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
			local previous = ui.views[viewId]
			ui.views[viewId] = {
				viewId = viewId, destinationId = request.body.destinationId, resolveIntentId = id, sessionId = session, draftToken = draft,
				state = previous and copy(previous.state) or { serverInstance = "broker-fixture", binding = { sessionId = session, clientId = null, revision = 0 }, devices = {} },
			}
			ui.views[viewId].state.binding.sessionId = session
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
		function f.replaceBlock(pane, kind, block)
			blocks[pane].kind, blocks[pane].block = kind, block
		end
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
		function f.reanchor(pane, owner)
			assert(floatingPane(tabs[paneTabs[pane]], pane)).over = owner
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
			while f.setupOpens == 0 do
				turns += 1; assert(turns < 20)
				if f.hasRequest("/v1/state") then f.respond(f.take("/v1/state"), ui) else f.tick() end
			end
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
					for _, secret in { "fixture-token", "destination-A", "session-A", "draft-A", "/synthetic", "/isolated", "http://" } do
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

	case("reboot missing endpoint resumes only the authorized local client", function(f)
		f.authorizeResume(); f.missingEndpoint = true
		assert(f.ioCount() == 0 and #f.moduleLoads == 0, "load hook performed startup IO")
		f.untilState(function() return #f.processes == 1 end)
		local process = f.processes[1]
		assert(#process.argv == 5 and process.argv[1] == "/approved/bun")
		assert(process.argv[2] == "/approved/package with spaces/src/cli.ts" and process.argv[3] == "resume-client")
		assert(process.argv[4] == "--plugin-data" and process.argv[5] == "/isolated/plugin-data")
		assert(process.options.timeout_ms == 45000 and process.options.shell == nil)
		assert(f.status()[1].text == "Starting local Bridge")
		f.invoke("setup"); f.invoke("toggle-bridge"); f.tick()
		assert(#f.processes == 1 and f.setupOpens == 0, "concurrent repair duplicated launch")
		f.finishResume()
		assert(f.status()[1].text == "Starting local Bridge", "process receipt mutated presentation")
		f.missingEndpoint = false
		f.poll()
		assert(#f.processes == 1 and f.status()[1].text ~= "Starting local Bridge")
		f.chromeIsPure()
	end)

	case("missing recovery authorization requires consented Setup", function(f)
		f.missingEndpoint, f.fakeSetup = true, true
		f.untilState(function() return f.status()[1].text == "Set up Bridge" end)
		assert(#f.processes == 0)
		f.invoke("setup")
		f.untilState(function() return f.setupOpens == 1 end)
		assert(#f.processes == 0)
	end)

	case("explicit repair discovers newly installed recovery authorization", function(f)
		f.missingEndpoint = true
		f.untilState(function() return f.status()[1].text == "Set up Bridge" end)
		f.authorizeResume(); f.invoke("setup")
		f.untilState(function() return #f.processes == 1 end)
		assert(f.setupOpens == 0, "new authorization was ignored in favor of provisioning")
	end)

	for _, fault in { "json", "schema", "kind", "runtime", "packageRoot", "stateDir", "controlFile", "config", "relation", "traversal", "extra", "digest", "permission" } do
		case("invalid resume authorization fails closed: " .. fault, function(f)
			f.authorizeResume(); f.missingEndpoint = true
			if fault == "json" then f.resumeMalformed = true
			elseif fault == "schema" then f.resumePlan.schema = 2
			elseif fault == "kind" then f.resumePlan.kind = "setup"
			elseif fault == "config" then f.resumePlan.controlFile = "/other/client.json"
			elseif fault == "relation" then f.resumePlan.stateDir = "/other"
			elseif fault == "traversal" then f.resumePlan.runtime = "/approved/../other/bun"
			elseif fault == "extra" then f.resumePlan.token = "unapproved-secret"
			elseif fault == "digest" then f.resumePlan.packageDigest = "changed"
			elseif fault == "permission" then f.resumeReadError = "Permission denied"
			else f.resumePlan[fault] = "relative/path" end
			f.untilState(function() return f.status()[1].text == "Bridge start failed" end)
			for _ = 1, 6 do f.tick() end
			assert(#f.processes == 0 and f.setupOpens == 0, "invalid receipt provisioned a service")
			f.chromeIsPure()
		end)
	end

	for _, fault in { "failure", "timeout", "missing callback", "start", "invalid result" } do
		case("resume failure is bounded and needs explicit retry: " .. fault, function(f)
			f.authorizeResume(); f.missingEndpoint = true
			f.processStartError = fault == "start"
			if f.processStartError then f.untilState(function() return f.status()[1].text == "Bridge start failed" end)
			else
				f.untilState(function() return #f.processes == 1 end)
				if fault == "missing callback" then f.advance(45001)
				else f.finishResume({ status = fault == "failure" and 1 or 0, timed_out = fault == "timeout", stdout = "invalid-json", stderr = "private-secret" }) end
				f.untilState(function() return f.status()[1].text == "Bridge start failed" end)
			end
			local count = #f.processes
			for _ = 1, 6 do f.tick() end
			assert(#f.processes == count and f.setupOpens == 0)
			f.processStartError = false
			f.invoke("setup")
			f.untilState(function() return #f.processes == count + 1 end)
			assert(f.setupOpens == 0, "authorized retry opened provisioning")
		end)
	end

	case("healthy then stopped client never respawns without explicit repair", function(f)
		f.warm(); f.authorizeResume()
		f.fetchError, f.missingEndpoint = true, true
		for _ = 1, 10 do f.tick() end
		assert(#f.processes == 0 and #f.sent == 0, "intentional stop triggered a watchdog restart")
		f.invoke("setup")
		f.untilState(function() return #f.processes == 1 end)
		f.finishResume(); f.fetchError, f.missingEndpoint = false, false; f.poll()
		f.fetchError = true
		for _ = 1, 10 do f.tick() end
		assert(#f.processes == 1 and #f.sent == 0, "later failure restarted or replayed automatically")
	end)

	case("cold Setup intent waits for authorized recovery instead of provisioning", function(f)
		f.authorizeResume(); f.missingEndpoint, f.fakeSetup = true, true
		f.reload(); f.invoke("setup")
		assert(#f.moduleLoads == 0 and f.ioCount() == 0)
		f.untilState(function() return #f.processes == 1 end)
		assert(f.setupOpens == 0 and #f.moduleLoads == 0)
		f.finishResume(); f.missingEndpoint = false; f.poll()
		assert(f.setupOpens == 0 and #f.moduleLoads == 0, "fulfilled cold recovery intent opened provisioning")
	end)

	case("Setup before first connecting health receipt cannot start another client", function(f)
		f.authorizeResume(); f.connected(false); f.fakeSetup = true
		f.tick(); f.invoke("setup")
		f.untilState(function() return f.hasRequest("/v1/state") end)
		f.invoke("setup")
		assert(#f.moduleLoads == 0 and #f.processes == 0)
		f.poll()
		assert(f.status()[1].text == "Waiting for connection")
		assert(#f.moduleLoads == 0 and #f.processes == 0 and f.setupOpens == 0)
		f.fetchError, f.missingEndpoint = true, true
		for _ = 1, 10 do f.tick() end
		assert(#f.processes == 0, "healthy connecting client did not seal automatic recovery")
	end)

	case("invalid installed configuration never reads or launches resume authorization", function(f)
		f.authorizeResume(); f.missingEndpoint = true
		f.config = { controlFile = "relative/client.json" }
		f.tick(); f.tick()
		assert(f.status()[1].text == "Bridge endpoint needs attention" and #f.processes == 0)
		for _, path in f.reads do assert(path ~= "/isolated/plugin-data/client-resume.json") end
	end)

	case("timed out process cannot overwrite an explicit retry with a late receipt", function(f)
		f.authorizeResume(); f.missingEndpoint = true
		f.untilState(function() return #f.processes == 1 end)
		local stale = f.processes[1].callback
		f.advance(45001)
		f.untilState(function() return f.status()[1].text == "Bridge start failed" end)
		f.invoke("setup")
		f.untilState(function() return #f.processes == 2 end)
		stale({ status = 1, stdout = "invalid-json", stderr = "private-secret" })
		f.tick()
		assert(f.status()[1].text == "Starting local Bridge", "late process receipt displaced the active retry")
		f.finishResume(); f.missingEndpoint = false; f.poll()
		assert(#f.processes == 2 and f.status()[1].text ~= "Bridge start failed")
	end)

	case("malformed recovery result never becomes a successful start", function(f)
		f.authorizeResume(); f.missingEndpoint = true
		f.untilState(function() return #f.processes == 1 end)
		f.finishResume({ status = 0, stdout = tern.json.encode({ kind = "client", controlFile = "/other/client.json", deviceId = "other" }), timed_out = false })
		f.untilState(function() return f.status()[1].text == "Bridge start failed" end)
		assert(#f.processes == 1 and f.setupOpens == 0)
	end)


	case("verified install without resume authorization exposes Setup and later opens ordinary Bridge", function(f)
		f.missingEndpoint = true
		assert(f.completeSetup() == "awaiting")
		f.untilState(function() return f.status()[1].text == "Set up Bridge" end)
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

	case("verified install with absent config exposes actionable configuration error", function(f)
		f.missingConnection = true
		assert(f.completeSetup() == "awaiting")
		f.tick()
		assert(f.status()[1].text == "Bridge endpoint needs attention")
		f.missingConnection = false
		f.poll()
		assert(f.setupCallbacks.onConnected() == "ready")
	end)

	case("setup module load failure is visible and a later explicit open can recover", function(f)
		f.poll()
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
			assert(f.status()[1].text == (platform == "windows" and "Starting local Bridge" or "Bridge endpoint needs attention"))
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

	case("failed local service request opens startup recovery instead of repeating an error", function(f)
		f.fetchError = true
		f.tick(); f.tick(); f.tick()
		f.fakeSetup = true
		f.invoke("toggle-bridge")
		local turns = 0
		while f.setupOpens == 0 do turns += 1; assert(turns < 20, "dead service has no recovery entry"); f.tick() end
		assert(#f.creations == 0 and #f.errors == 0)
		f.noRequest("/v1/panels/open")
		f.fetchError = false
		f.poll()
		f.toggle()
		assert(#f.creations == 1 and f.setupOpens == 1, "healthy service remained trapped in recovery")
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

	case("healthy connecting client retains reconnection ownership without duplicate startup", function(f)
		f.warm(); f.authorizeResume()
		f.connected(false); f.poll()
		f.fakeSetup = true
		f.invoke("toggle-bridge"); f.invoke("setup"); f.invoke("devices")
		assert(f.status()[1].text == "Waiting for connection")
		assert(#f.processes == 0 and f.setupOpens == 0 and #f.moduleLoads == 0)
		assert(#f.errors == 0 and #f.creations == 0)
		f.noRequest("/v1/panels/open")
		for _, path in f.reads do assert(path ~= "/isolated/plugin-data/client-resume.json", "healthy client read recovery authorization") end
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
		f.toggle()
		assert(created and floated and #f.floats == 1)
		assert(f.layout().focus == f.panelPane, "panel did not become interactive")
		f.toggle()
		f.assertOriginalTab()
		assert(not f.isOpen(f.panelPane) and next(f.layout().floats) == nil and f.tab(f.panelTab) == nil)
	end)

	for _, failure in { "floatFalse", "floatError" } do
		case("native " .. failure .. " self-closes only the owned temporary panel", function(f)
			nestedOriginal(f)
			local unrelated = f.original + 200
			local unrelatedTab = f.addTabPane(unrelated)
			f.addFloat(unrelated + 1, f.other)
			f.warm()
			f[failure] = true
			f.toggle()
			assert(#f.floats == 1 and f.floats[1].pane == f.panelPane and f.floats[1].owner == f.original)
			assert(#f.closes == 1 and f.closes[1] == f.panelPane and not f.isOpen(f.panelPane), "float failure did not request the owned block's broker self-close")
			assert(f.tab(f.panelTab) == nil and f.floating(f.panelPane) == nil, "failed float left its temporary tab or PiP behind")
			assert(#f.layout().floats == 1 and f.floating(unrelated + 1).over == f.other and f.floating(unrelated + 1).size[1] == 315, "failure cleanup changed an unrelated PiP")
			assert(f.isOpen(unrelated) and f.tab(unrelatedTab).root.pane == unrelated, "failure cleanup touched an unrelated tab")
			assert(#f.focuses == 0 and #f.actions == 0 and #f.errors == 1)
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
			assert(#f.floats == 0 and #f.actions == 0 and #f.focuses == 0, "changed context still received native PiP work")
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
		assert(pip.over == f.original and pip.corner == "top_right", "Bridge lost its exact owner or placement")
		assert(f.paneTab(first) == 1 and f.tab(f.panelTab) == nil, "float left the panel in its temporary tab")
		assert(f.layout().focus == first, "Bridge is not focused for interaction by default")
		f.assertOriginalTab()
		assert(#f.floats == 1 and #f.focuses == 1 and f.focuses[1] == first and #f.processes == 0, "automatic PiP must float and focus exactly once without processes")
		f.userResize(first, 47, 39)
		f.focus(f.original); f.userResize(first, 29, 31)
		f.poll(); f.focus(first); f.invoke("focus", {}); f.poll()
		assert(#f.floats == 1 and #f.focuses == 1, "focus loss or polling reapplied geometry")
		assert(f.link("paste").handled)
		f.respond(f.take("/v1/captures/clipboard"), { kind = "text", text = "panel text" })
		f.resolve(f.take("/v1/intents", f.viewId), "session-A", "draft-A")
		assert(f.pasted()[1].viewId == f.viewId and f.pasted()[1].sessionId == "session-A", "panel paste followed panel focus")
		assert(#f.picks == 0 and #f.prompts == 0, "explicit paste opened a redundant dialog")
		assert(f.floating(first).focus_size[1] == 47 and f.floating(first).focus_size[2] == 39 and f.floating(first).size[1] == 29 and f.floating(first).size[2] == 31, "paste or polling overwrote either user size")
		f.toggle()
		assert(#f.closes == 1 and f.closes[1] == first and f.isOpen(f.original) and f.isOpen(f.other))
		assert(f.floating(first) == nil and not f.isOpen(first), "hide left its owned PiP behind")
		f.assertOriginalTab()
		f.noRequest("/v1/transfers/cancel")
		f.toggle()
		assert(f.panelPane ~= first and #f.creations == 2 and #f.floats == 2 and #f.focuses == 2 and f.focuses[2] == f.panelPane)
		local reopened = assert(f.floating(f.panelPane))
		assert(reopened.corner == "top_right" and reopened.over == f.original)
		assert(reopened.size[1] == pip.size[1] and reopened.size[2] == pip.size[2] and reopened.focus_size[1] == pip.focus_size[1] and reopened.focus_size[2] == pip.focus_size[2], "fresh panel inherited a closed panel's user geometry")
		f.assertOriginalTab()
		assert(f.creations[1].launch.args[2] ~= f.creations[2].launch.args[2], "recreated panel reused stale route id")
	end)

	case("automatic PiP focuses its panel without input or original layout mutation", function(f)
		f.warm(); f.toggle()
		assert(#f.floats == 1 and f.floats[1].pane == f.panelPane and f.floats[1].owner == f.original, "Bridge floated another pane or owner")
		assert(f.layout().focus == f.panelPane and f.paneTab(f.panelPane) == 1, "Bridge did not focus the panel over its original tab")
		assert(#f.sent == 0 and #f.native == 0 and #f.processes == 0 and #f.actions == 0 and #f.focuses == 1, "PiP used a process, pane input, or focus traversal")
		f.assertOriginalTab()
		f.focus(f.other); f.poll(); f.advance(5000); f.poll(); f.flushPanels()
		assert(f.layout().focus == f.other and #f.focuses == 1 and #f.floats == 1, "heartbeat stole focus or reapplied PiP geometry")
	end)

	for _, platform in { "macos", "linux", "windows" } do
		case("native PiP opens without process API or CLI configuration on " .. platform, function(f)
			tern.runtime.os, tern.process = platform, nil
			f.config = { controlFile = "/isolated/client.json" }
			f.warm(); f.toggle()
			assert(#f.errors == 0 and #f.creations == 1 and #f.floats == 1 and #f.focuses == 1)
			assert(f.focuses[1] == f.panelPane and f.layout().focus == f.panelPane)
			f.assertOriginalTab()
		end)
	end

	local function beginFloat(f)
		f.invoke("toggle-bridge")
		f.respond(f.take("/v1/panels/open"), { ok = true }, nil, true)
		assert(#f.floats == 0 and #f.focuses == 0, "HTTP callback performed native layout work")
		local turns = 0
		while #f.floats == 0 do turns += 1; assert(turns <= 4, "native float was not scheduled"); f.step() end
		assert(#f.floats == 1 and #f.focuses == 0 and f.layout().focus == f.original)
	end

	local function readyCount(f)
		local count = 0
		for _, record in f.logs do if record.event == "panel.pip.ready" then count += 1 end end
		return count
	end

	case("native focus success is reported only by a fresh observed context", function(f)
		f.warm(); beginFloat(f)
		assert(readyCount(f) == 0)
		f.step()
		assert(#f.focuses == 1 and f.focuses[1] == f.panelPane and f.layout().focus == f.panelPane)
		assert(readyCount(f) == 0, "native void return was treated as observed success")
		f.step()
		assert(readyCount(f) == 1 and #f.errors == 0)
		f.poll(); f.flushPanels()
		assert(#f.focuses == 1 and readyCount(f) == 1, "poll duplicated native focus or success")
	end)

	for _, change in { "owner", "other pane", "other tab", "delayed focus" } do
		case("accepted focus never retries or steals focus after " .. change, function(f)
			f.warm(); beginFloat(f)
			f.delayFocus = change == "delayed focus"
			f.step()
			assert(#f.focuses == 1)
			local selected = f.original
			if change == "other pane" then selected = f.other
			elseif change == "other tab" then selected = f.original + 200; f.addTabPane(selected) end
			f.focus(selected)
			f.flush(); f.poll(); f.advance(5000); f.poll(); f.flushPanels()
			assert(f.layout().focus == selected and #f.focuses == 1 and #f.floats == 1)
			assert(readyCount(f) == 0 and #f.closes == 0 and f.isOpen(f.panelPane))
			f.focus(f.panelPane); f.poll(); f.flushPanels()
			assert(#f.focuses == 1 and readyCount(f) == 0, "late focus revived completed initialization")
		end)
	end

	case("user focusing the newly floated panel makes another native request unnecessary", function(f)
		f.warm(); beginFloat(f)
		f.focus(f.panelPane); f.flush()
		assert(#f.focuses == 0 and readyCount(f) == 1 and #f.errors == 0)
		f.focus(f.original); f.poll(); f.flushPanels()
		assert(#f.focuses == 0 and f.layout().focus == f.original)
	end)

	case("native focus failure preserves the floated panel without fallback or retry", function(f)
		f.warm(); f.focusError = true; f.toggle()
		assert(#f.focuses == 1 and f.focuses[1] == f.panelPane and #f.errors == 1)
		assert(f.errors[1]:find("native window API", 1, true) and not f.errors[1]:find("private host detail", 1, true))
		assert(f.floating(f.panelPane) and f.isOpen(f.panelPane) and #f.closes == 0 and f.layout().focus == f.original)
		assert(readyCount(f) == 0 and #f.processes == 0 and #f.sent == 0 and #f.native == 0)
		f.focusError = false; f.poll(); f.flushPanels()
		assert(#f.focuses == 1 and #f.errors == 1 and readyCount(f) == 0)
		f.assertOriginalTab()
	end)

	for _, stage in { "float", "focus" } do
		for _, change in { "focus", "host", "session", "tab", "closed destination", "foreign destination", "moved destination", "owner destination" } do
			case("automatic PiP cancels after " .. stage .. " on changed " .. change, function(f)
				f.warm()
				local stoppedAt
				local function changeContext()
					assert(stoppedAt == nil, "native operation was repeated")
					stoppedAt = #f.focuses
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
				if stage == "float" then f.onFloat = changeContext else f.onFocus = changeContext end
				f.toggle()
				assert(stoppedAt ~= nil and #f.focuses == stoppedAt and readyCount(f) == 0, "PiP continued in a stale destination context")
				assert(f.isOpen(f.panelPane) and #f.closes == 0 and f.tab(f.panelTab) == nil, "post-float cancellation closed the user's PiP")
				f.poll(); f.flushPanels()
				assert(#f.focuses == stoppedAt and #f.floats == 1, "poll restarted stale PiP work")
				if change == "tab" then assert(f.layout().focus == f.original + 200) end
				if change == "focus" then assert(f.layout().focus == f.other) end
				assert(f.isOpen(f.other) and #f.sent == 0 and #f.native == 0 and #f.actions == 0)
				if change ~= "closed destination" and change ~= "moved destination" then f.assertOriginalTab() end
			end)
		end
	end

	for _, missing in { "surface", "owner nonce", "float", "layout" } do
		case("unavailable floated " .. missing .. " never guesses a PiP target", function(f)
			f.warm(); beginFloat(f)
			if missing == "surface" then f.nativeSurfaceMissing = f.panelPane
			elseif missing == "owner nonce" then f.panelSurfaceOwner = "another-window/another-panel"
			elseif missing == "float" then f.missingFloat = true
			else f.layoutError = true end
			f.step()
			f.advance(10001); f.flush(); f.flushPanels()
			assert(#f.focuses == 0 and #f.closes == 0 and f.isOpen(f.panelPane) and readyCount(f) == 0)
			assert(#f.errors == (missing == "float" and 0 or 1), "lookup failure or render timeout was not reported exactly once")
			f.nativeSurfaceMissing, f.panelSurfaceOwner, f.missingFloat, f.layoutError = nil, nil, nil, nil
			f.poll(); f.flushPanels()
			assert(#f.focuses == 0, "restored metadata restarted cancelled initialization")
			f.assertOriginalTab()
		end)
	end

	case("nonce replacement after native focus cannot produce successful verification", function(f)
		f.warm(); beginFloat(f); f.step()
		f.panelSurfaceOwner = "another-window/another-panel"
		f.step(); f.advance(10001); f.flush(); f.flushPanels()
		assert(#f.focuses == 1 and readyCount(f) == 0 and #f.errors == 1 and #f.closes == 0)
	end)

	for _, reorder in { "insert", "remove" } do
		case("exact opaque pane focus ignores unrelated PiP " .. reorder, function(f)
			local unrelated, foreign = f.original + 300, f.original + 400
			f.addFloat(unrelated, f.other)
			local foreignTab = f.addTabPane(foreign)
			f.addFloat(foreign + 1, foreign)
			f.warm(); beginFloat(f)
			if reorder == "remove" then f.removeFloat(unrelated)
			else f.addFloat(unrelated + 1, f.other, true) end
			f.flush(); f.flushPanels()
			assert(#f.focuses == 1 and f.focuses[1] == f.panelPane and f.layout().focus == f.panelPane)
			assert(f.floats[1].pane == f.panelPane and f.floats[1].owner == f.original)
			if reorder == "insert" then
				assert(f.floating(unrelated).size[1] == 315 and f.floating(unrelated).focus_size[2] == 330)
				assert(f.floating(unrelated + 1).over == f.other and f.floating(unrelated + 1).corner == "bottom_left")
			else assert(not f.isOpen(unrelated)) end
			assert(f.tab(foreignTab).root.pane == foreign and f.floating(foreign + 1).over == foreign)
			assert(f.floating(foreign + 1).size[1] == 315 and f.floating(foreign + 1).focus_size[2] == 330)
			f.assertOriginalTab()
		end)
	end

	for _, replacement in { "kind", "block" } do
		case("unexpected created " .. replacement .. " cancels before native float", function(f)
			f.warm(); f.invoke("toggle-bridge")
			f.respond(f.take("/v1/panels/open"), { ok = true }, nil, true)
			f.replaceBlock(f.panelPane, replacement == "kind" and "terminal" or "plugin", replacement == "block" and "unrelated.block" or "omp-client-bridge.panel")
			f.flush(); f.flushPanels()
			assert(#f.floats == 0 and #f.focuses == 0 and #f.closes == 1 and not f.isOpen(f.panelPane))
			f.assertOriginalTab()
		end)
	end

	for _, change in { "owner", "tab", "closed" } do
		case("moved or closed floated panel cannot redirect native focus: " .. change, function(f)
			f.warm(); beginFloat(f)
			if change == "owner" then f.reanchor(f.panelPane, f.other)
			elseif change == "tab" then f.movePaneToTab(f.panelPane)
			else f.removeFloat(f.panelPane) end
			f.flush(); f.flushPanels(); f.poll(); f.flushPanels()
			assert(#f.focuses == 0 and #f.closes == 0 and readyCount(f) == 0 and f.layout().focus == f.original)
			if change ~= "closed" then assert(f.isOpen(f.panelPane)) end
			f.assertOriginalTab()
		end)
	end

	case("user sizing between float and focus survives initialization and polling", function(f)
		f.warm(); beginFloat(f)
		f.userResize(f.panelPane, 27, 35)
		f.flush()
		assert(f.layout().focus == f.panelPane and #f.focuses == 1)
		f.userResize(f.panelPane, 43, 48)
		f.focus(f.original); f.poll(); f.focus(f.panelPane); f.poll(); f.flushPanels()
		local pip = f.floating(f.panelPane)
		assert(pip.size[1] == 27 and pip.size[2] == 35 and pip.focus_size[1] == 43 and pip.focus_size[2] == 48)
		assert(#f.floats == 1 and #f.focuses == 1)
	end)

	case("late surface rendering permits one focus while the original context is unchanged", function(f)
		f.warm(); beginFloat(f)
		f.nativeSurfaceMissing = f.panelPane
		f.step(); f.step()
		assert(#f.focuses == 0 and readyCount(f) == 0)
		f.nativeSurfaceMissing = nil
		f.flush(); f.flushPanels()
		assert(#f.focuses == 1 and f.layout().focus == f.panelPane and readyCount(f) == 1 and #f.errors == 0)
	end)

	case("expired temporary initialization closes only its owned panel without floating", function(f)
		f.warm(); f.invoke("toggle-bridge")
		f.respond(f.take("/v1/panels/open"), { ok = true }, nil, true)
		f.advance(10001); f.flush(); f.flushPanels()
		assert(#f.floats == 0 and #f.focuses == 0 and #f.closes == 1 and #f.errors == 1)
		assert(not f.isOpen(f.panelPane) and f.tab(f.panelTab) == nil)
		f.assertOriginalTab()
	end)

	case("queued native work from a closed panel cannot initialize its replacement", function(f)
		f.warm(); beginFloat(f)
		local old = f.panelPane
		f.dispatch("toggle-bridge") -- Revoke ownership without draining the old focus timer.
		f.dispatch("toggle-bridge") -- Explicitly reopen in the still-focused original OMP.
		f.flushPanels()
		assert(not f.isOpen(old) and f.panelPane ~= old and #f.creations == 2)
		assert(#f.floats == 2 and #f.focuses == 1 and f.focuses[1] == f.panelPane)
		assert(f.layout().focus == f.panelPane and readyCount(f) == 1 and #f.errors == 0)
		f.assertOriginalTab()
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
		f.toggle()
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
		assert(#f.errors == 1 and #f.floats == 0 and #f.focuses == 0 and #f.closes == 0)
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

	for _, close in { "toggle", "broker" } do
		case("closed panel retires its publication failure: " .. close, function(f)
			f.warm(); f.toggle()
			f.advance(5000); f.poll()
			f.respond(f.take("/v1/panels/publish"), { error = "Fixture publication unavailable" }, 503)
			assert(f.status()[1].text == "Needs attention", "live panel failure was hidden")
			if close == "toggle" then f.toggle() else f.closePanel() end
			f.poll()
			assert(f.status()[1].text ~= "Needs attention", "closed panel left a permanent attention status")
			f.noRequest("/v1/captures/clipboard")
		end)
	end

	case("panel snapshots are bounded public data and heartbeat never resizes", function(f)
		f.warm()
		f.toggle()
		local floats, focuses = #f.floats, #f.focuses
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
		f.flushPanels(); assert(#f.snapshots == count + 1 and #f.floats == floats and #f.focuses == focuses)
	end)

	case("panel focus and inline choice publication never open a picker or submit a binding", function(f)
		f.warm()
		f.binding(nil, { { id = "client-A", name = "Desk Mac", online = true, platform = "darwin" } })
		f.invoke("devices"); f.flushPanels()
		local pane = f.panelPane
		f.invoke("focus", {})
		f.noRequest("/v1/intents")
		-- Native host form-change behavior is covered by the shipped host harness;
		-- this boundary captures its actual choice event without inventing a bind.
		assert(f.choices().options[2].key == "d1")
		f.invoke("devices"); f.flushPanels()
		f.focus(f.original); f.invoke("devices"); f.flushPanels()
		assert(f.panelPane == pane and f.layout().focus == pane and #f.creations == 1 and #f.closes == 0,
			"inline focus changed panel ownership: " .. tostring(f.panelPane == pane) .. "/" .. tostring(f.layout().focus == pane) .. "/" .. tostring(#f.creations) .. "/" .. tostring(#f.closes) .. "/" .. tostring(f.errors[#f.errors]))
		assert(#f.picks == 0 and #f.binds() == 0, "selection or opening performed a binding")
		f.noRequest("/v1/intents")
		assert(f.link("devices").handled and #f.picks == 0, "obsolete Devices link still opened a picker")
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

	case("explicit inline Apply binds only the frozen original client and retains operation receipts", function(f)
		f.warm()
		f.binding(nil, { { id = "client-A", name = "Desk Mac", online = true, platform = "darwin" } }, 7)
		f.toggle()
		local choices = f.choices()
		assert(choices.available and choices.current == "none" and choices.options[2].key == "d1")
		local request = f.linkRequest("bind/" .. choices.generation .. "/d1")
		local before = f.ioCount()
		assert(f.dispatch("link", request).handled and f.ioCount() == before)
		f.flush()
		assert(#f.binds() == 0, "Apply skipped fresh conversation validation")
		f.resolve(f.take("/v1/intents", f.viewId), "session-A", "draft-A")
		local bind = f.take("/v1/intents", f.viewId)
		assert(bind.body.kind == "bind" and bind.body.clientId == "client-A" and bind.body.expectedRevision == 7)
		assert(bind.body.viewId == f.viewId and bind.body.sessionId == "session-A" and bind.body.draftToken == "draft-A")
		f.respond(bind, { id = "bind-receipt", expiresAt = 60000 })
		f.outcomes({ { id = "bind-receipt", viewId = f.viewId, kind = "bind", error = "Binding rejected by agent" } })
		assert(#f.errors == 1 and f.errors[1] == "Binding rejected by agent")
		f.poll(); assert(#f.errors == 1 and #f.binds() == 0)
	end)

	case("inline choices contain only bounded public fields and stable heartbeat generations", function(f)
		f.warm()
		local devices = {}
		for index = 1, 40 do table.insert(devices, { id = "private-device-" .. index, name = string.rep("界", 100), platform = "darwin", online = index ~= 2 }) end
		f.binding(nil, devices); f.toggle()
		local value, count = f.choices(), #f.deviceEvents
		local fields = { owner = true, panelId = true, generation = true, available = true, current = true, options = true }
		for key in value do assert(fields[key], "private field crossed native selection boundary") end
		assert(value.generation:match("^[1-9]%d*$") and #value.options == 33 and value.options[1].key == "none")
		for _, option in value.options do
			for key in option do assert(key == "key" or key == "label" or key == "detail" or key == "disabled") end
			assert(#option.label <= 240 and #option.detail <= 240 and utf8.len(option.label) ~= nil)
		end
		assert(value.options[3].disabled and not value.options[2].disabled)
		f.poll(); f.flushPanels(); assert(#f.deviceEvents == count)
		f.advance(5000); f.poll(); f.flushPanels()
		assert(#f.deviceEvents == count + 1 and f.choices().generation == value.generation)
		assert(f.deviceEvents[#f.deviceEvents].at - f.deviceEvents[count].at >= 5000)
		assert(#f.binds() == 0 and #f.picks == 0)
	end)

	for _, change in { "generation", "unknown key", "malformed key", "foreign window", "foreign panel", "wrong pane", "focus", "nonce", "expired", "offline", "revoked", "reordered", "revision", "disconnected" } do
		case("inline Apply fails closed before resolve after " .. change, function(f)
			f.warm()
			local devices = {
				{ id = "client-A", name = "Desk Mac", online = true, platform = "darwin" },
				{ id = "client-B", name = "Other Mac", online = true, platform = "darwin" },
			}
			f.binding(nil, devices, 3); f.toggle()
			local generation = f.choices().generation
			local path = "bind/" .. (change == "generation" and "999999" or generation) .. "/" .. (change == "unknown key" and "d32" or change == "malformed key" and "d01" or "d1")
			local request = f.linkRequest(path, change == "wrong pane" and f.original or nil,
				change == "foreign window" and "another-window" or nil, change == "foreign panel" and "old-panel" or nil)
			if change == "focus" then f.focus(f.other)
			elseif change == "nonce" then f.panelSurfaceOwner = "another-window/another-panel"
			elseif change == "expired" then f.advance(15001)
			elseif change == "offline" then devices[1].online = false; f.binding(nil, devices, 3)
			elseif change == "revoked" then f.binding(nil, { devices[2] }, 3)
			elseif change == "reordered" then f.binding(nil, { devices[2], devices[1] }, 3)
			elseif change == "revision" then f.binding(nil, devices, 4)
			elseif change == "disconnected" then f.connected(false); f.poll() end
			local before = f.ioCount()
			assert(f.dispatch("link", request).handled); f.flush()
			assert(#f.binds() == 0 and #f.picks == 0 and f.ioCount() == before)
			assert(#f.errors > 0, "invalid inline Apply failed silently")
		end)
	end

	for _, change in { "session", "draft", "revision", "offline", "revoked", "reordered", "focus", "panel closed" } do
		case("inline Apply revalidates frozen choices after fresh resolve changes " .. change, function(f)
			f.warm()
			local devices = {
				{ id = "client-A", name = "Desk Mac", online = true, platform = "darwin" },
				{ id = "client-B", name = "Other Mac", online = true, platform = "darwin" },
			}
			f.binding(nil, devices, 3); f.toggle()
			local generation = f.choices().generation
			f.link("bind/" .. generation .. "/d1")
			local validate = f.take("/v1/intents", f.viewId)
			if change == "revision" then f.binding(nil, devices, 4)
			elseif change == "offline" then devices[1].online = false; f.binding(nil, devices, 3)
			elseif change == "revoked" then f.binding(nil, { devices[2] }, 3)
			elseif change == "reordered" then f.binding(nil, { devices[2], devices[1] }, 3)
			elseif change == "focus" then f.focus(f.other)
			elseif change == "panel closed" then f.toggle() end
			f.resolve(validate, change == "session" and "session-B" or "session-A", change == "draft" and "draft-B" or "draft-A")
			assert(#f.binds() == 0 and #f.errors > 0, "changed inline choices retargeted a binding")
		end)
	end

	case("reordering unrelated devices invalidates old keys rather than retargeting the selected device", function(f)
		f.warm()
		local a = { id = "client-A", name = "Desk Mac", online = true, platform = "darwin" }
		local b = { id = "client-B", name = "Other Mac", online = true, platform = "darwin" }
		f.binding(nil, { a, b }); f.toggle()
		local old = f.choices().generation
		f.binding(nil, { b, a }); f.flushPanels()
		assert(f.choices().generation ~= old)
		f.link("bind/" .. old .. "/d1")
		assert(#f.binds() == 0)
		-- A new explicit selection of Desk Mac uses its new key, never an old index.
		f.poll(); f.flushPanels()
		f.link("bind/" .. f.choices().generation .. "/d2")
		f.resolve(f.take("/v1/intents", f.viewId), "session-A", "draft-A")
		assert(f.take("/v1/intents", f.viewId).body.clientId == "client-A")
	end)

	case("explicit Unbound Apply uses the cached null mapping and unchanged selection is rejected", function(f)
		f.warm()
		f.binding("client-A", { { id = "client-A", name = "Desk Mac", online = true, platform = "darwin" } }, 2)
		f.toggle()
		assert(f.choices().current == "d1")
		f.link("bind/" .. f.choices().generation .. "/d1")
		assert(#f.binds() == 0)
		f.poll(); f.flushPanels()
		f.link("bind/" .. f.choices().generation .. "/none")
		f.resolve(f.take("/v1/intents", f.viewId), "session-A", "draft-A")
		local bind = f.take("/v1/intents", f.viewId)
		assert(bind.body.kind == "bind" and bind.body.clientId == tern.json.null and bind.body.expectedRevision == 2)
	end)

	case("missing current binding stays unavailable without presenting a false Unbound selection", function(f)
		f.warm()
		f.binding("revoked-client", { { id = "client-A", name = "Desk Mac", online = true, platform = "darwin" } }, 4)
		f.toggle()
		local choices = f.choices()
		assert(not choices.available and choices.current == "" and choices.options[1].key == "none")
		f.link("bind/" .. choices.generation .. "/d1")
		assert(#f.binds() == 0 and #f.errors == 1)
	end)

	case("device command in another session preserves the existing owned panel", function(f)
		f.warm(); f.toggle()
		local pane = f.panelPane
		f.currentSession = 2; f.focus(f.other)
		f.invoke("devices"); f.flushPanels()
		assert(f.panelPane == pane and f.isOpen(pane) and #f.closes == 0 and #f.creations == 1)
		assert(f.layout().focus == f.other and #f.picks == 0 and #f.binds() == 0)
	end)

	case("failed native choice delivery grants no Apply authority", function(f)
		f.warm()
		f.binding(nil, { { id = "client-A", name = "Desk Mac", online = true, platform = "darwin" } })
		f.eventError = true; f.toggle()
		assert(#f.deviceEvents == 0)
		f.link("bind/1/d1")
		assert(#f.binds() == 0 and #f.errors == 1)
	end)

	case("inline generation changes with device label and online state but not binding-free refresh", function(f)
		f.warm()
		local devices = { { id = "client-A", name = "Desk Mac", online = true, platform = "darwin" } }
		f.binding(nil, devices); f.toggle()
		local generation = f.choices().generation
		devices[1].name = "Renamed Mac"; f.binding(nil, devices); f.flushPanels()
		assert(f.choices().generation ~= generation and f.choices().options[2].label == "Renamed Mac")
		generation = f.choices().generation
		devices[1].online = false; f.binding(nil, devices); f.flushPanels()
		assert(f.choices().generation ~= generation and f.choices().options[2].disabled)
		generation = f.choices().generation
		f.poll(); f.flushPanels(); assert(f.choices().generation == generation and #f.binds() == 0)
	end)

	print("PASS: " .. tostring(passed) .. " synthetic SDK-boundary cases executing shipped window.luau; native Tern/clipboard/editor acceptance remains separate")
end
