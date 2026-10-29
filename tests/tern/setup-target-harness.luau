-- SPDX-License-Identifier: MPL-2.0
-- Runs the shipped pure helper without Tern, networking, or filesystem access.
function run(target)
	local passed = 0
	local function check(value, message)
		assert(value, message)
		passed += 1
	end
	local function eq(actual, expected, message) check(actual == expected, message .. ": " .. tostring(actual)) end

	local accepted = {
		{ "build-alias", "build-alias" }, { "user@dev.example", "user@dev.example" },
		{ "192.0.2.5", "192.0.2.5" }, { "root@192.0.2.5:2222", "ssh://root@192.0.2.5:2222" },
		{ "dev.example:22", "ssh://dev.example:22" }, { "dev.example:65535", "ssh://dev.example:65535" },
		{ "ssh://dev.example", "ssh://dev.example" }, { "ssh://user@dev.example:2222", "ssh://user@dev.example:2222" },
		{ "2001:db8::1", "2001:db8::1" }, { "user@2001:db8::1", "user@2001:db8::1" },
		{ "[2001:db8::1]", "ssh://[2001:db8::1]" }, { "user@[2001:db8::1]:2222", "ssh://user@[2001:db8::1]:2222" },
		{ "ssh://user@[::1]:22", "ssh://user@[::1]:22" }, { "[::ffff:192.0.2.5]", "ssh://[::ffff:192.0.2.5]" },
		{ "[2001:db8:0:0:0:0:0:1]", "ssh://[2001:db8:0:0:0:0:0:1]" },
	}
	for _, pair in ipairs(accepted) do
		eq(target.candidate(pair[1]), pair[2], "normalize " .. pair[1])
		check(target.validHost(pair[2]), "normalized destination is backend-compatible")
	end
	local opaque = string.rep("a1", 32)
	local rejected = {
		"", "-oProxyCommand=anything", " host", "host ", "host\tname", "host\nname", "host\000name", "host\127name",
		"host;id", "host|id", "host&other", "$(id)", "`id`", "host'quote", 'host"quote', "host\\path", "host/path",
		"http://dev.example", "tern://dev.example", "relay://dev.example", "node:" .. opaque, opaque, string.upper(opaque),
		"user@" .. opaque, "ssh://" .. opaque, "ssh://user@" .. opaque .. ":22",
		"host:0", "host:65536", "host:-1", "host:abc", "host:", "host:22:33", "host:000022",
		"ssh://host/", "ssh://host/path", "ssh://host?x", "ssh://host#x", "ssh://user:password@host",
		"ssh://2001:db8::1", "user@@host", "@host", "-user@host", "user@-host", "host..example", "999.0.0.1",
		"[host]:22", "[2001:db8::1]:0", "[2001:db8::1]:65536", "[2001:db8::1]:x", "[::1]junk",
		"[2001:::1]", "[2001::db8::1]", "[12345::1]", "[1:2:3]", "[1:2:3:4:5:6:7:8:9]", "[1:2:3:4:5:6:7:8::]",
		"[::ffff:999.0.0.1]", "[::ffff:192.0.2.5:1]", string.rep("a", 256),
	}
	for _, value in ipairs(rejected) do
		eq(target.candidate(value), nil, "reject unsafe or non-SSH address")
		check(not target.validHost(value), "reject invalid destination")
	end
	eq(target.candidate({ name = "user@display-name", address = "user@actual.example" }), nil, "never infer from host dictionaries")
	eq(target.candidate(nil), nil, "absent address")
	check(not target.validHost("host:22"), "raw colon port must be normalized before backend use")

	local one = { id = 1, name = "user@display-one", address = "user@actual-one.example", kind = "remote", state = "connected", identity = { address = "wrong.example" } }
	local two = { id = 2, name = "user@display-two", address = opaque, kind = "remote", state = "connected" }
	local localHost = { id = 3, name = "Local", kind = "local", state = "connected" }
	local offline = { id = 4, name = "Offline", address = "offline.example", kind = "remote", state = "failed" }
	local rows = target.choices({ one, localHost, two, offline }, two)
	eq(#rows, 3, "connected remotes plus manual only")
	eq(rows[1].selection.id, 2, "current first")
	eq(rows[2].selection.id, 1, "remaining order")
	eq(rows[3].label, "Enter SSH address manually", "manual label")
	check(rows[3].manual, "manual always last")
	eq(target.candidate(rows[1].selection.address), nil, "opaque remote requires manual SSH address, not display name")
	eq(target.candidate(rows[2].selection.address), "user@actual-one.example", "native address only")
	check(rows[2].selection ~= one and rows[2].selection.identity == nil, "selection is a primitive snapshot")
	one.name = "Renamed"
	eq(rows[2].selection.name, "user@display-one", "snapshot does not change with native object")
	check(target.selectionValid(rows[2].selection, { two, one }), "current switch preserves captured selection")
	one.address = "replacement.example"
	check(not target.selectionValid(rows[2].selection, { one, two }), "same id with changed address rejected")
	one.address = rows[2].selection.address
	one.state = "reconnecting"
	check(not target.selectionValid(rows[2].selection, { one }), "disconnected selection rejected")
	one.state = "connected"
	one.id = 9
	check(not target.selectionValid(rows[2].selection, { one }), "same address with different id rejected")
	one.id = 1
	one.kind = "local"
	check(not target.selectionValid(rows[2].selection, { one }), "local replacement rejected")
	check(not target.selectionValid(rows[2].selection, nil), "unavailable host list fails closed")
	check(target.selectionValid(nil, nil), "manual has no host constraint")
	check(target.selectionValid({ manual = true }, {}), "explicit manual selection")
	check(not target.selectionValid({ manual = true, id = 1 }, {}), "manual flag cannot bypass native selection")
	check(not target.selectionValid({}, {}), "malformed selection rejected")
	eq(#target.choices({ localHost, offline }, localHost), 1, "local-only or disconnected yields manual")
	eq(#target.choices(nil, two), 1, "unavailable list does not infer current host")
	eq(#target.choices({}, nil), 1, "empty host list")
	local absent = { id = 7, name = "user@not-an-address", kind = "remote", state = "connected" }
	local missingRows = target.choices({ absent }, nil)
	eq(missingRows[1].selection.address, nil, "no fallback from display name")
	check(target.selectionValid(missingRows[1].selection, { absent }), "native identity without address can be explicitly mapped for this invocation")

	local args = target.preflightArgs("ssh://user@[2001:db8::1]:2222")
	eq(args[1], "ssh", "direct ssh executable")
	eq(args[#args - 1], "ssh://user@[2001:db8::1]:2222", "destination is separate argv, unchanged")
	local options = {}
	for index, value in ipairs(args) do if value == "-o" then options[args[index + 1]] = true end end
	for _, value in ipairs({ "BatchMode=yes", "ForwardAgent=no", "StrictHostKeyChecking=yes", "UpdateHostKeys=no", "ClearAllForwardings=yes", "ControlPath=none", "PermitLocalCommand=no", "ConnectTimeout=10", "ConnectionAttempts=1" }) do
		check(options[value], "strict SSH option " .. value)
	end
	eq(args[2], "-T", "no terminal allocation")
	eq(args[3], "-n", "no interactive stdin")
	local other = target.preflightArgs("other.example")
	eq(args[#args], other[#other], "remote program is constant, no destination interpolation")
	check(not string.find(args[#args], "curl", 1, true) and not string.find(args[#args], "wget", 1, true), "no downloader in probe")
	check(not pcall(target.preflightArgs, "-oUnsafe=yes"), "invalid destination cannot produce argv")

	local prefix = "TERN_OMP_SSH_PREFLIGHT_V1\t"
	local function result(status, stdout, stderr, timedOut)
		return target.preflightResult({ status = status, stdout = stdout or "", stderr = stderr or "", timed_out = timedOut or false })
	end
	local function failure(actual, code)
		eq(actual.ok, false, "failure cannot authorize install")
		eq(actual.code, code, "public failure class")
		check(type(actual.message) == "string" and #actual.message > 0 and #actual.message < 240, "bounded public message")
		check(not string.find(actual.message, "SECRET", 1, true), "no raw diagnostics disclosure")
	end
	for _, system in ipairs({ "Linux", "Darwin" }) do
		for _, arch in ipairs({ "x86_64", "amd64", "aarch64", "arm64" }) do
			local actual = result(0, prefix .. system .. "\t" .. arch .. "\n")
			check(actual.ok, "exact supported success")
			eq(actual.system, system, "platform returned")
			eq(actual.arch, arch, "architecture returned")
		end
	end
	local success = prefix .. "Linux\tx86_64\n"
	for _, stdout in ipairs({ "", "Linux\nx86_64\n", "OK\n", success .. success, "banner\n" .. success, success .. "banner", string.sub(success, 1, -2), prefix .. "Linux\tx86_64\r\n", prefix .. "FreeBSD\tx86_64\n", prefix .. "Linux\ts390x\n", "TERN_OMP_SSH_PREFLIGHT_V2\tLinux\tx86_64\n", string.rep("X", 9000) }) do
		failure(result(0, stdout), "invalid_output")
	end
	eq(result(0, success, "Authorized access only\n").ok, true, "SSH informational stderr does not invalidate a successful probe")
	failure(result(255, success, "SECRET failure"), "failed")
	failure(result(0, success, "", true), "timeout")
	for _, marker in ipairs({ { 20, "platform", "unsupported_platform" }, { 21, "tools", "missing_tools" }, { 22, "home", "invalid_home" }, { 23, "shell", "unsupported_shell" } }) do
		failure(result(marker[1], prefix .. "ERROR\t" .. marker[2] .. "\n"), marker[3])
		failure(result(marker[1], prefix .. "ERROR\t" .. marker[2] .. "\n", "Authorized access only\n"), marker[3])
		failure(result(0, prefix .. "ERROR\t" .. marker[2] .. "\n"), "invalid_output")
		failure(result(marker[1], ""), "failed")
	end
	for _, diagnostic in ipairs({ "Permission denied (publickey).", "Authentication failed.", "Too many authentication failures", "No supported authentication methods available" }) do
		failure(result(255, "", diagnostic .. " SECRET"), "authentication")
	end
	for _, diagnostic in ipairs({ "Host key verification failed.", "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!", "No ED25519 host key is known for SECRET" }) do
		failure(result(255, "", diagnostic), "host_key")
	end
	for _, diagnostic in ipairs({ "Could not resolve hostname SECRET", "Name or service not known", "Connection refused", "No route to host", "Network is unreachable", "Connection reset by peer", "Connection closed by SECRET" }) do
		failure(result(255, "", diagnostic), "network")
	end
	failure(result(255, "", "Connection timed out SECRET"), "timeout")
	failure(result(255, "", "Operation timed out SECRET"), "timeout")
	failure(target.preflightResult(nil), "missing_ssh")
	failure(result(127, "", "ssh: command not found SECRET"), "missing_ssh")
	failure(result(-1, "", "spawn ssh: No such file or directory SECRET"), "missing_ssh")
	failure(result(127, "", "sh: not found SECRET"), "missing_tools")
	failure(result(1, "", "unknown SECRET"), "failed")
	failure(target.preflightResult({}), "failed")
	failure(target.preflightResult("SECRET"), "failed")
	failure(result(255, "", string.rep("X", 8192) .. "Permission denied SECRET"), "failed")
	print("Setup target helper assertions passed: " .. tostring(passed))
end
