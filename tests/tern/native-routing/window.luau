-- SPDX-License-Identifier: MPL-2.0
-- Diagnostic ONLY. Install in an isolated TERN_CONFIG_DIR / daemon, never user config.
-- The probe never reads or changes clipboard data. In a synthetic OMP draft,
-- compare standard Cmd/Ctrl+V against palette Paste, with empty/nonempty/native
-- selection fields, native editing on/off, and streaming output. An actual
-- native paste with unchanged counter demonstrates bypass of command overrides.
-- Drop a synthetic file over an unfocused pane. Compare the counter's recorded
-- focused id with the pane hovered: OpenRequest has no destination-pane member.
local count = 0
local dropped = nil
tern.override("paste", function(cx)
	count += 1
	tern.chrome.refresh()
	cx:toast("info", "Paste command override reached", "Count " .. tostring(count) .. "; focused pane " .. tostring(cx.session:focused()))
	return false -- Native action must continue unchanged.
end)
tern.route.open(function(req, cx)
	if req.origin == "drop" then
		dropped = { focused = cx.session:focused(), host = req.host, how = req.how }
		tern.chrome.refresh()
		cx:toast("info", "File drop route reached", tern.json.encode(dropped))
	end
	return nil
end)
tern.command({ id = "stats", title = "Bridge probe: paste and drop routing", run = function(cx)
	cx:toast("info", "Paste override count: " .. tostring(count), dropped and tern.json.encode(dropped) or "No drop route observed")
end })
tern.chrome.status(function(_)
	return { { text = "Paste overrides: " .. tostring(count), command = "plugin.bridge-input-probe.stats" } }
end)
