-- SPDX-License-Identifier: MPL-2.0
-- Synthetic native SDK boundary; executes the shipped renderer, not Tern itself.
function run(moduleEntry, hostEntry)
	local passed = 0
	local function copy(value)
		if type(value) ~= "table" then return value end
		local result = {}
		for k, v in value do result[k] = copy(v) end
		return result
	end
	local function fixture(kind, args, saved)
		kind = kind or "panel"
		local definition, clock, renders, serial, alive = nil, 0, 0, 0, true
		local timers, encoded, frames = {}, {}, {}
		local function node(k, p, c) return { k = k, p = p, c = c } end
		local ui = {
			node = node, col = function(c) return node("col", nil, c) end,
			row = function(c) return node("row", nil, c) end,
			span = function(t, s) assert(type(t) == "string"); return { t = t, s = s } end,
			text = function(t) return node("text", { text = t }) end,
			badge = function(t, tone) return node("badge", { text = t, tone = tone }) end,
			progress = function(v, t) assert(v == nil); return node("progress", { label = t }) end,
			el = function(tag, p, c) assert(tag == "button"); p = copy(p); p.tag = tag; return node("el", p, c) end,
		}
		tern = setmetatable({
			ui = ui, plugin = { id = kind == "panel" and "omp-bridge-setup" or "omp-client-bridge" },
			now = function() return clock end,
			pane = { list = function() return alive and { { pane = 101 } } or {} end },
			timer = function(ms, fn) assert(ms == 5000); table.insert(timers, fn) end,
			json = { null = {}, decode = function(v) assert(encoded[v], "Invalid JSON"); return copy(encoded[v]) end },
			block = { define = function(id, def) assert(id == kind and not definition); definition = def end },
		}, { __index = function(_, name) error("Forbidden host effect: " .. tostring(name)) end })
		local cx = setmetatable({
			pane = 101,
			render = function() renders += 1 end,
			frame = function(_, ops)
				assert(#ops == 1 and ops[1][1] == "focus", "Only native field focus may be emitted")
				assert(ops[1][2] == "main.ssh" or ops[1][2] == tern.json.null)
				table.insert(frames, ops)
			end,
		}, { __index = function(_, name) error("Forbidden host context effect: " .. tostring(name)) end })
		local module = moduleEntry()
		if kind == "panel" then hostEntry(function(path) assert(path == "./view"); return module end)
		else module.register(kind) end
		assert(definition.features[1] == "edit" and definition.features[2] == "undo")
		local f = { def = definition, cx = cx, frames = frames }
		f.state = definition.init(cx, args or { "window-1", "panel-1" }, saved)
		function f.event(ev) definition.event(f.state, ev, cx) end
		function f.send(v)
			serial += 1
			local token = "snapshot-" .. tostring(serial)
			encoded[token] = copy(v)
			f.event({ ev = "action", act = "setup-snapshot", value = token })
		end
		function f.key(k) return definition.key(f.state, k, cx) end
		function f.focus() f.event({ ev = "focus", id = "main.ssh" }) end
		function f.view() return definition.view(f.state, cx) end
		function f.advance(ms) clock += ms end
		function f.tick() assert(table.remove(timers, 1))() end
		function f.renders() return renders end
		function f.close() alive = false end
		function f.timerCount() return #timers end
		return f
	end
	local function sample(phase, revision)
		return {
			owner = "window-1", panelId = "panel-1", revision = revision or 1, phase = phase or "choose",
			stage = "Checking target", message = "Choose a destination", ssh = "dev@remote.example",
			selectedLabel = "Development host", selectedAddress = "dev@remote.example", platform = "linux",
			hosts = {
				{ key = "remote/a %中", label = "Development host", detail = "Remote host" },
				{ key = "2", label = "Enter SSH address manually", detail = "", manual = true },
			},
			canCheck = true, canInstall = phase == "review", canRecover = false, canRetry = phase == "failed" or phase == "interrupted",
			canChoose = true, busy = phase == "checking" or phase == "installing",
		}
	end
	local function nodes(view)
		local result = {}
		local function visit(n, id)
			assert(type(n.k) == "string")
			result[id] = n
			local seen = {}
			for index, child in n.c or {} do
				local key = tostring(child.p and child.p.key or index - 1)
				assert(not seen[key], "Duplicate sibling key")
				seen[key] = true
				visit(child, id .. "." .. key)
			end
		end
		visit(view.main, "main")
		visit(view.dock, "dock")
		return result
	end
	local function strings(value, result)
		result = result or {}
		if type(value) == "string" then table.insert(result, value)
		elseif type(value) == "table" then for _, v in value do strings(v, result) end end
		return result
	end
	local function text(v) return table.concat(strings(v), "\n") end
	local function contains(v, expected) assert(text(v):find(expected, 1, true), "Missing: " .. expected) end
	local function excludes(v, needle) assert(not text(v):find(needle, 1, true), "Leaked: " .. needle) end
	local function actionable(view)
		local result = {}
		for id, node in nodes(view) do
			if node.k == "el" then
				if node.p.actions then
					assert(node.p.actions.click == "open" or node.p.actions.click:match("^setup%-"))
					assert((node.p.href ~= nil) == (node.p.actions.click == "open"))
					assert(node.p.attrs["aria-disabled"] == false)
					table.insert(result, id)
				else assert(node.p.href == nil and node.p.attrs["aria-disabled"]) end
			end
		end
		return result
	end
	local function click(f, id)
		local node = assert(nodes(f.view())[id], "Missing action: " .. id)
		assert(node.p.actions and node.p.actions.click ~= "open", "Expected a native local action")
		f.event({ ev = "action", id = id, act = node.p.actions.click })
	end
	local function renderedCount(view, needle)
		local count = 0
		for _, node in nodes(view) do
			if node.k == "text" or node.k == "input" then
				for _, value in strings(node.p.text) do
					local start = 1
					while true do
						local first, last = value:find(needle, start, true)
						if not first then break end
						count += 1; start = last + 1
					end
				end
			end
		end
		return count
	end
	local function test(name, fn) fn(); passed += 1; print("PASS " .. name) end

	test("host-only entry and main factory register correct surface roles", function()
		for _, kind in { "panel", "setup" } do
			local f = fixture(kind)
			assert(f.view().main.p.role == (kind == "panel" and "omp-bridge-setup.panel" or "omp-client-bridge.setup"))
			assert(f.def.title() == "Bridge Setup" and #actionable(f.view()) == 1)
		end
	end)
	test("phase layout exposes only relevant form and actions", function()
		for _, phase in { "choose", "checking", "review", "installing", "ready", "awaiting_session", "failed", "interrupted" } do
			local f = fixture(); f.send(sample(phase))
			local view, expected = f.view(), nil
			local n = nodes(view)
			assert(n["main.target"] and n["main.subtitle"] and not n["main.phase"] and not n["main.steps"] and not n["main.hosts"])
			assert((n["main.ssh"] ~= nil) == (phase == "choose" or phase == "checking"))
			assert((n["main.consent"] ~= nil) == (phase == "review"))
			assert((n["main.progress"] ~= nil) == (phase == "checking" or phase == "installing"))
			if phase == "choose" then expected = "main.actions.check"
			elseif phase == "review" then expected = "main.actions.install"
			elseif phase == "failed" or phase == "interrupted" then expected = "main.actions.retry" end
			local primaries = 0
			for id, node in n do
				if node.p and node.p.class and node.p.class:find("setup-primary", 1, true) then
					primaries += 1; assert(id == expected)
				end
			end
			assert(primaries == (expected and 1 or 0))
			assert(renderedCount(view, "Development host") == 1 and renderedCount(view, "dev@remote.example") == 1)
			f.event({ ev = "action", act = "install" }); assert(f.state.snapshot.phase == phase)
		end
	end)
	test("review retains complete scope and explicitly routed installation", function()
		local f = fixture(); local s = sample("review"); s.canRecover = true; f.send(s)
		local view = f.view()
		assert(nodes(view)["main.actions.install"].p.href == "omp-bridge-setup://window-1/panel-1/1/install/dev%40remote.example")
		assert(nodes(view)["main.actions.recover"].p.href == "omp-bridge-setup://window-1/panel-1/1/recover/dev%40remote.example")
	end)
	test("host disclosure is local and closes only on newer accepted snapshots", function()
		local f = fixture(); local s = sample(); f.send(s)
		click(f, "main.target.heading.change")
		assert(nodes(f.view())["main.hosts"] and f.state.revision == 1 and f.state.ssh == s.ssh)
		assert(nodes(f.view())["main.hosts.host-1"].p.href == "omp-bridge-setup://window-1/panel-1/1/select/remote%2Fa%20%25%E4%B8%AD")
		f.send(s); assert(nodes(f.view())["main.hosts"])
		local wrong = sample("choose", 2); wrong.owner = "other"; f.send(wrong); assert(nodes(f.view())["main.hosts"])
		click(f, "main.target.heading.cancel"); assert(not nodes(f.view())["main.hosts"])
		click(f, "main.target.heading.change")
		f.send(sample("choose", 2)); assert(not nodes(f.view())["main.hosts"])
	end)
	test("manual choice uses one supplied numeric key without label inference", function()
		local f = fixture(); local s = sample()
		table.insert(s.hosts, { key = "3", label = "Another manual label", manual = true })
		table.insert(s.hosts, copy(s.hosts[1]))
		f.send(s); click(f, "main.target.heading.change")
		local n = nodes(f.view())
		assert(#f.state.snapshot.hosts == 2 and n["main.hosts.host-2"].p.href == "omp-bridge-setup://window-1/panel-1/1/select/2")
		assert(renderedCount(f.view(), "Enter SSH address manually") == 1)
		s.hosts = { { key = "1", label = "Enter SSH address manually", manual = false } }; s.revision = 2
		f.send(s); click(f, "main.target.heading.change")
		assert(#f.state.snapshot.hosts == 1 and f.state.snapshot.hosts[1].manual == false)
	end)
	test("review and failure edit preserve target and require a new SSH check", function()
		for _, phase in { "review", "failed", "interrupted" } do
			local f = fixture(); local s = sample(phase); s.canRecover = true; f.send(s)
			click(f, "main.actions.edit")
			assert(f.state.snapshot.selectedLabel == s.selectedLabel and f.state.ssh == s.ssh)
			assert(nodes(f.view())["main.ssh"] and not nodes(f.view())["main.actions.install"] and not nodes(f.view())["main.actions.retry"])
			f.focus(); f.key({ name = "x", text = "x" })
			assert(f.state.dirty and nodes(f.view())["main.actions.check"].p.href:find("/check/", 1, true))
			f.send(s); assert(f.state.dirty and nodes(f.view())["main.ssh"])
			f.send(sample("review", 2)); assert(not nodes(f.view())["main.ssh"] and nodes(f.view())["main.actions.install"].p.href)
		end
	end)
	test("details remain disclosed locally instead of repeating stage explanations", function()
		local f = fixture(); local s = sample("review"); f.send(s)
		assert(renderedCount(f.view(), s.message) == 0)
		click(f, "main.footer.details"); assert(renderedCount(f.view(), s.message) == 1)
		click(f, "main.footer.details"); assert(renderedCount(f.view(), s.message) == 0)
	end)
	test("normalized SSH URIs retain exact destinations and enable safe action URLs", function()
		for _, pair in {
			{ "ssh://dev@remote.example:2222", "ssh%3A%2F%2Fdev%40remote.example%3A2222" },
			{ "ssh://dev@[2001:db8::1]:2222", "ssh%3A%2F%2Fdev%40%5B2001%3Adb8%3A%3A1%5D%3A2222" },
			{ "ssh://remote.example", "ssh%3A%2F%2Fremote.example" },
		} do
			local f = fixture(); local s = sample("review"); s.ssh, s.selectedAddress, s.canRecover = pair[1], pair[1], true; f.send(s)
			local n = nodes(f.view())
			assert(not n["main.ssh"] and f.state.snapshot.selectedAddress == pair[1])
			assert(n["main.actions.install"].p.href == "omp-bridge-setup://window-1/panel-1/1/install/" .. pair[2])
			assert(n["main.actions.recover"].p.href == "omp-bridge-setup://window-1/panel-1/1/recover/" .. pair[2])
			click(f, "main.actions.edit"); n = nodes(f.view())
			assert(n["main.ssh"].p.text == pair[1] and n["main.actions.check"].p.href == "omp-bridge-setup://window-1/panel-1/1/check/" .. pair[2])
		end
		for _, value in { "https://host", "ftp://host", "ssh://", "ssh://user:password@host", "ssh://host/path", "ssh://host?secret=value", "ssh://-option", "ssh://user@-option" } do
			local f = fixture(); local s = sample("review"); s.ssh, s.selectedAddress = value, value; f.send(s)
			local n = nodes(f.view())
			assert(f.state.ssh == "" and f.state.snapshot.selectedAddress == nil)
			assert(n["main.actions.install"].p.href == nil)
			click(f, "main.actions.edit"); assert(nodes(f.view())["main.actions.check"].p.href == nil)
		end
	end)
	test("native focus and key edits populate percent-encoded Check action", function()
		local f = fixture(); f.send(sample()); f.focus()
		assert(f.frames[1][1][2] == "main.ssh")
		assert(f.key({ name = "a", ctrl = true }))
		assert(f.key({ name = "paste", text = "user@[2001:db8::1]" }))
		assert(nodes(f.view())["main.ssh"].p.text == "user@[2001:db8::1]")
		assert(nodes(f.view())["main.actions.check"].p.href == "omp-bridge-setup://window-1/panel-1/1/check/user%40%5B2001%3Adb8%3A%3A1%5D")
		assert(f.key({ name = "enter" }) == false)
		assert(not nodes(f.view())["main.hosts"])
	end)
	test("UTF-16 edit replacement, stale lengths and surrogate boundaries", function()
		local f = fixture(); f.send(sample()); f.focus(); f.key({ name = "a", meta = true }); f.key({ name = "paste", text = "a😀中z" })
		assert(f.state.cursor == 5)
		f.event({ ev = "edit", id = "main.ssh", from = 1, to = 3, text = "b", cursor = 2, len = 5 })
		assert(f.state.ssh == "ab中z" and f.state.cursor == 2)
		f.event({ ev = "edit", id = "main.ssh", from = 0, to = 4, text = "wrong", cursor = 5, len = 5 })
		assert(f.state.ssh == "ab中z")
		f.event({ ev = "undo", id = "main.ssh" }); assert(f.state.ssh == "a😀中z")
		f.event({ ev = "edit", id = "main.ssh", from = 2, to = 3, text = "bad", cursor = 4, len = 5 })
		assert(f.state.ssh == "a😀中z")
		f.event({ ev = "edit", id = "main.ssh", from = 1, to = 1, text = "", cursor = 1, len = 5 })
		f.key({ name = "delete" }); assert(f.state.ssh == "a中z")
	end)
	test("word movement and deletion stay separate from Meta line chords", function()
		local f = fixture(); f.send(sample()); f.focus()
		local function enter(value)
			f.key({ name = "a", ctrl = true }); f.key({ name = "paste", text = value })
		end
		enter("alpha.beta gamma")
		f.key({ name = "left", alt = true }); assert(f.state.cursor == 11)
		f.key({ name = "left", ctrl = true }); assert(f.state.cursor == 6)
		f.key({ name = "right", ctrl = true, shift = true }); assert(f.state.cursor == 10 and f.state.anchor == 6)
		f.key({ name = "backspace", ctrl = true }); assert(f.state.ssh == "alpha. gamma")
		enter("alpha.beta gamma")
		f.key({ name = "backspace", ctrl = true }); assert(f.state.ssh == "alpha.beta ")
		f.key({ name = "backspace", alt = true }); assert(f.state.ssh == "alpha.")
		f.key({ name = "backspace", meta = true }); assert(f.state.ssh == "")
		enter("alpha.beta gamma"); f.key({ name = "home" })
		f.key({ name = "delete", ctrl = true }); assert(f.state.ssh == ".beta gamma")
		f.key({ name = "delete", alt = true }); assert(f.state.ssh == " gamma")
		f.key({ name = "delete", meta = true }); assert(f.state.ssh == "")
		enter("a😀中.beta")
		f.key({ name = "left", alt = true }); assert(f.state.cursor == 5)
		f.key({ name = "left", ctrl = true }); assert(f.state.cursor == 0)
		f.key({ name = "right", alt = true }); assert(f.state.cursor == 4)
		f.key({ name = "right", meta = true }); assert(f.state.cursor == 9)
		f.key({ name = "left", meta = true }); assert(f.state.cursor == 0)
	end)
	test("dirty input selection survives heartbeat but newer revision replaces it", function()
		local f = fixture(); local s = sample("review"); s.canRecover = true; f.send(s)
		click(f, "main.actions.edit"); f.focus(); f.key({ name = "x", text = "x" }); f.key({ name = "left", shift = true })
		local before = { f.state.ssh, f.state.cursor, f.state.anchor }
		f.send(s); assert(f.state.ssh == before[1] and f.state.cursor == before[2] and f.state.anchor == before[3])
		assert(nodes(f.view())["main.actions.install"] == nil and nodes(f.view())["main.actions.recover"] == nil)
		f.send(sample("review", 2)); assert(not f.state.dirty and f.state.ssh == "dev@remote.example" and f.state.anchor == nil)
	end)
	test("wrong owner panel stale revision and malformed snapshots are inert", function()
		local f = fixture(); f.send(sample("review", 4))
		for _, field in { "owner", "panelId", "phase" } do local s = sample("choose", 5); s[field] = "wrong"; f.send(s) end
		for _, revision in { -1, 0.5, 3, math.huge, 0 / 0 } do f.send(sample("choose", revision)) end
		f.event({ ev = "action", act = "setup-snapshot", value = "not JSON" })
		f.event({ ev = "action", act = "setup-snapshot", value = string.rep("x", 65537) })
		assert(f.state.revision == 4 and f.state.snapshot.phase == "review")
		local invalid = fixture(nil, { "bad/owner", "panel-1" }); invalid.send(sample()); assert(#actionable(invalid.view()) == 0)
	end)
	test("busy controls are inert even with contradictory capability flags", function()
		local f = fixture(); local s = sample("review"); s.busy = true; s.canRecover = true; f.send(s); f.focus()
		assert(#actionable(f.view()) == 1 and not nodes(f.view())["main.ssh"])
		assert(f.key({ name = "paste", text = "new" }) == false)
		f.event({ ev = "edit", id = "main.ssh", from = 0, to = 18, text = "new", cursor = 3, len = 18 })
		assert(f.state.ssh == "dev@remote.example")
	end)
	test("busy phases freeze open pickers and local editor actions", function()
		for _, phase in { "checking", "installing" } do
			local f = fixture(); f.send(sample())
			click(f, "main.target.heading.change")
			local s = sample(phase); s.busy = false; f.send(s)
			assert(f.state.picker and #actionable(f.view()) == 1)
			f.event({ ev = "action", act = "setup-cancel" }); assert(f.state.picker)
			f.event({ ev = "action", act = "setup-edit" }); assert(not f.state.editing)
			f.send(sample("review", 2)); assert(not f.state.picker)
		end
	end)
	test("completed phases reject hidden editor and host disclosure actions", function()
		for _, phase in { "ready", "awaiting_session" } do
			local f = fixture(); f.send(sample(phase))
			f.event({ ev = "action", act = "setup-change" })
			f.event({ ev = "action", act = "setup-edit" }); f.focus()
			assert(not f.state.editing and not f.state.picker and not f.state.focused)
			assert(not nodes(f.view())["main.ssh"] and #actionable(f.view()) == 1)
		end
	end)
	test("expiration freezes disclosures edits and routes until a fresh snapshot", function()
		local f = fixture(); local s = sample("failed"); s.error = "SSH check rejected"; f.send(s)
		click(f, "main.actions.edit"); f.focus(); click(f, "main.target.heading.change")
		f.advance(15000); f.tick()
		assert(f.renders() == 1 and #actionable(f.view()) == 1)
		contains(f.view(), "SSH check rejected"); contains(f.view(), "Connection lost")
		assert(not nodes(f.view())["main.ssh"] and f.key({ name = "x", text = "x" }) == false)
		f.event({ ev = "action", act = "setup-cancel" }); assert(f.state.picker)
		f.send(sample("choose", 0)); assert(#actionable(f.view()) == 1)
		f.send(s); assert(f.state.picker and not nodes(f.view())["main.ssh"])
		click(f, "main.target.heading.cancel"); assert(not f.state.picker and not nodes(f.view())["main.ssh"].p.readonly)
		f.close(); f.tick(); assert(f.timerCount() == 0)
	end)
	test("errors and retry/edit persist through repeated views", function()
		for _, phase in { "failed", "interrupted" } do
			local f = fixture(); local s = sample(phase); s.error = "Installation needs attention"; s.message = s.error; f.send(s)
			for _ = 1, 3 do
				local view = f.view(); contains(view, s.error)
				assert(renderedCount(view, s.error) == 1)
				assert(nodes(view)["main.actions.retry"].p.href ~= nil)
				assert(nodes(view)["main.actions.edit"].p.actions.click == "setup-edit" and nodes(view)["main.actions.edit"].p.href == nil)
			end
		end
	end)
	test("bounded snapshots whitelist public state and never persist secrets", function()
		local f = fixture(); local s = sample(); s.token = "SECRET_TOKEN"; s.raw = "SECRET_DIAGNOSTICS"; s.hosts = {}
		for i = 1, 50 do s.hosts[i] = { key = tostring(i), label = string.rep("中", 200), detail = "Safe", password = "SECRET_PASSWORD" } end
		s.message = string.rep("m", 10000); f.send(s)
		assert(#f.state.snapshot.hosts == 32 and #f.state.snapshot.message <= 243)
		for _, secret in { "SECRET_TOKEN", "SECRET_DIAGNOSTICS", "SECRET_PASSWORD" } do excludes(f.state, secret); excludes(f.view(), secret) end
		local count = 0; for _ in nodes(f.view()) do count += 1 end; assert(count < 220)
		assert(next(f.def.save(f.state)) == nil)
		local restored = fixture(nil, nil, f.state); assert(restored.state.snapshot == nil and restored.state.ssh == "" and #actionable(restored.view()) == 1)
	end)
	test("bounded input rejects controls and never links password or command text", function()
		local f = fixture(); f.send(sample()); f.focus(); f.key({ name = "a", ctrl = true })
		assert(not f.key({ name = "paste", text = string.rep("x", 256) }))
		assert(not f.key({ name = "paste", text = "host\ncommand" }))
		f.key({ name = "paste", text = "user:password@host" }); assert(nodes(f.view())["main.actions.check"].p.href == nil)
		for i = 1, 40 do f.key({ name = "x", text = "x" }) end
		assert(#f.state.history == 32)
		local s = sample(); s.ssh = "ssh://user:SECRET@host"; s.selectedAddress = s.ssh; f.send(s)
		excludes(f.state.snapshot, "SECRET"); excludes(f.view(), "SECRET")
	end)
	test("unselected setup offers host choices instead of a disabled SSH form", function()
		local f = fixture(); local s = sample(); s.canCheck = false; s.selectedLabel = nil; s.selectedAddress = nil; s.ssh = ""; f.send(s)
		local n = nodes(f.view()); assert(n["main.hosts"] and not n["main.ssh"] and not n["main.actions.check"])
		assert(n["main.hosts.host-1"].p.href and n["main.hosts.host-2"].p.href)
	end)
	test("changing the host hides the previous target install action until cancelled", function()
		local f = fixture(); f.send(sample("review")); click(f, "main.target.heading.change")
		local n = nodes(f.view()); assert(n["main.hosts"] and not n["main.actions.install"] and not n["main.consent"])
		click(f, "main.target.heading.cancel"); assert(nodes(f.view())["main.actions.install"].p.href)
	end)
	print("PASS " .. tostring(passed) .. " shipped setup-renderer behavior cases")
end
