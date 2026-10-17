-- SPDX-License-Identifier: MPL-2.0
-- Synthetic SDK boundary executing the actual shipped window.luau in Luau.
-- This is NOT native Tern, physical clipboard, editor, transport, or platform acceptance.
-- The fixture controls async receipts and fresh callback contexts, never copies the router.
function run(entry)
	local passed = 0
	local function fixture()
		local handlers, timers, requests, encoded = {}, {}, {}, {}
		local original, other = 17592186044423, 17592186044424
		local focused, remote, clock = original, true, 1
		local opened = { [original] = true, [other] = true }
		local serial, ioCount = 0, 0
		local null = {}
		local decodedState = nil
		local surfaceRole, paneKind = "omp.session", "agent"
		local f = { original = original, other = other, sent = {}, native = {}, errors = {} }
		local ui = { device = { id = "self", name = "Fixture client" }, connected = true, views = {}, transfers = {}, interactions = {} }
		local function copy(value)
			if type(value) ~= "table" or value == null then return value end
			local result = {}
			for key, item in value do result[key] = copy(item) end
			return result
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
				session = {
					focused = function() live(); return focused end,
					panes = function()
						live()
						local panes = {}
						for pane in opened do table.insert(panes, { pane = pane, program = "zsh", kind = paneKind, at_prompt = true }) end
						return panes
					end,
					surface = function(_, pane)
						live()
						if not opened[pane] then return nil end
						return { surface = { id = "s:fixture", mode = "inline", role = surfaceRole } }
					end,
				},
				hosts = { list = function()
					live()
					local panes = {}
					for pane in opened do table.insert(panes, pane) end
					return {
						{ name = "local", kind = "local", panes = {} },
						{ name = "agent", kind = remote and "remote" or "local", state = "connected", panes = panes },
					}
				end },
				run = function(_, pane, frame) live(); table.insert(f.sent, { pane = pane, frame = frame }) end,
				command = function(_, name) live(); table.insert(f.native, { command = name, pane = focused }) end,
				toast = function(_, level, _, message) live(); if level == "error" then table.insert(f.errors, message) end end,
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
			plugin = { data = "/isolated/plugin-data" },
			now = function() return clock end,
			json = { encode = encode, decode = function(token)
				local value = copy(assert(encoded[token], "unknown JSON token"))
				if value.views then decodedState = value end
				return value
			end, null = null },
			fs = { read = function(path)
				ioCount += 1
				if path == "/isolated/plugin-data/config.json" then return encode({ controlFile = "/isolated/client.json" }) end
				assert(path == "/isolated/client.json", "unexpected filesystem access")
				return encode({ url = "http://127.0.0.1:9999", token = "fixture-token" })
			end },
			fetch = function(url, options, callback)
				ioCount += 1
				assert(options.headers.Authorization == "Bearer fixture-token", "local UI authentication omitted")
				table.insert(requests, { path = url:sub(#"http://127.0.0.1:9999" + 1), body = options.body and copy(encoded[options.body]), callback = callback })
			end,
			timer = function(_, callback) table.insert(timers, callback) end,
			chrome = { refresh = function() end, status = function(callback) handlers.status = callback end },
			command = function() end,
			override = function(name, fn) handlers[name] = fn end,
			route = { open = function(fn) handlers.drop = fn end },
			on = function(name, fn) handlers[name] = fn end,
		}
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
		function f.respond(request, body, status)
			invoke(function(cx) request.callback({ status = status or 200, body = encode(body) }, cx) end)
		end
		function f.poll()
			invoke(assert(table.remove(timers, 1), "poll timer missing"))
			f.respond(f.take("/v1/state"), ui)
		end
		function f.invoke(name, ...) return invoke(assert(handlers[name], "missing native handler"), ...) end
		function f.drop()
			return f.invoke("drop", { origin = "drop", host = "local", path = "/synthetic/图 one.txt" })
		end
		function f.focus(pane) focused = pane end
		function f.remote(value) remote = value end
		function f.connected(value) ui.connected = value end
		function f.surface(role, kind) surfaceRole, paneKind = role, kind end
		function f.advance(ms) clock += ms end
		function f.receipt(request)
			serial += 1
			local id = "resolve-" .. tostring(serial)
			f.respond(request, { id = id, frame = "opaque:" .. id })
			return id
		end
		function f.publish(request, id, session, draft)
			local viewId = request.body.viewId
			ui.views[viewId] = {
				viewId = viewId, resolveIntentId = id, sessionId = session, draftToken = draft,
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
		function f.ready(transferId, frame)
			ui.transfers = { { id = transferId, viewId = f.viewId, phase = "ready", frame = frame, names = { "图 one.txt" }, bytesSent = 8, totalBytes = 8 } }
			f.poll()
		end
		function f.mutateCachedIdentity(session, draft)
			-- Adversarial alias check: a consumer changing the previously decoded table
			-- must not change the gesture's already-captured scalar destination.
			local view = assert(decodedState.views[f.viewId])
			view.sessionId, view.draftToken = session, draft
		end
		function f.closeOriginal()
			opened[original] = nil
			focused = other
			f.invoke("pane_closed", { pane = original })
		end
		function f.chromeIsPure()
			local before = ioCount
			assert(#handlers.status({ pane = original }) > 0, "status disappeared")
			assert(ioCount == before, "chrome formatter performed IO")
		end
		entry()
		return f
	end
	local function case(name, body)
		body(fixture())
		passed += 1
		print("PASS synthetic shipped-plugin behavior: " .. name)
	end

	case("ordinary native routing remains outside bridge scope", function(f)
		f.remote(false)
		assert(f.drop() == nil)
		assert(f.invoke("drop", { origin = "files", host = "local", path = "/synthetic/file.txt" }) == nil)
		assert(f.invoke("drop", { origin = "drop", host = "agent", path = "/synthetic/file.txt" }) == nil)
		f.noRequest("/v1/captures")
		f.chromeIsPure()
	end)

	case("terminal retaining an OMP surface is not an active destination", function(f)
		f.surface("omp.session", "terminal")
		assert(f.invoke("drop", { origin = "drop", host = "local", path = "/synthetic/file.txt" }) == nil)
		f.noRequest("/v1/intents")
		f.noRequest("/v1/captures")
	end)

	case("cold drop is consumed, and retry retains exact ordinary-file path", function(f)
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

	case("unchanged file retains original pane across focus and polling; ready frame is not replayed", function(f)
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
		local deliveries = 0
		for _, item in f.sent do
			if item.frame == "opaque-attachment" then
				deliveries += 1
				assert(item.pane == f.original, "attachment followed focus")
			end
		end
		assert(deliveries == 1, "ready attachment was lost or replayed")
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

	print("PASS: " .. tostring(passed) .. " synthetic SDK-boundary cases executing shipped window.luau; native Tern/clipboard/editor acceptance remains separate")
end
