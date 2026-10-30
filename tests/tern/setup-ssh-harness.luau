-- SPDX-License-Identifier: MPL-2.0
-- Executes shipped discovery with synthetic native receipts, never a second implementation.
function run(Discovery)
	local passed = 0
	local function check(value, message)
		assert(value, message)
		passed += 1
	end
	local function eq(actual, expected, message) check(actual == expected, message .. ": " .. tostring(actual)) end
	local function parsed(host, user, port, paths)
		local lines = {}
		for _, path in ipairs(paths or {}) do
			local escaped = string.gsub(path, ".", function(char)
				if char == "\\" then return "\\\\" end
				if string.byte(char) >= 128 or string.byte(char) < 32 then return string.format("\\%03o", string.byte(char)) end
				return char
			end)
			table.insert(lines, "debug1: Reading configuration data " .. escaped .. "\r\n")
		end
		return { status = 0, stdout = "hostname " .. host .. "\r\nuser " .. (user or "local-user") .. "\r\nport " .. tostring(port or 22) .. "\r\nidentityfile SECRET-KEY\r\n", stderr = table.concat(lines), timed_out = false }
	end
	local function drive(selection, saved, receipts, files, options)
		options = options or {}
		local job = Discovery.new(selection, saved, options.platform)
		check(not pcall(job.result), "unfinished discovery has no result")
		local operations, destinations, reads = {}, {}, {}
		while true do
			local operation = job.next()
			if not operation then break end
			table.insert(operations, operation)
			check(#operations <= 112, "bounded native operations")
			check(not pcall(job.next), "single outstanding operation")
			if operation.kind == "process" then
				if operation.purpose == "locate" then
					eq(operation.argv[1], "where.exe", "locate the SSH binary used by this Windows environment")
					job.accept(options.location or { status = 1, stdout = "", stderr = "", timed_out = false })
				elseif operation.purpose == "convert" then
					eq(operation.argv[1], options.converter, "use the selected SSH toolchain's companion converter")
					eq(operation.argv[2], "-w", "convert to a native Windows path")
					local converted = options.conversions and options.conversions[operation.argv[3]]
					job.accept({ status = converted and 0 or 1, stdout = converted and (converted .. "\r\n") or "", stderr = "", timed_out = false })
				else
				eq(operation.argv[1], "ssh", "native OpenSSH executable")
				eq(operation.argv[2], "-G", "configuration only, never authentication")
				eq(operation.argv[3], "-v", "native trace supplies paths")
				eq(operation.argv[4], "-o", "local command option boundary")
				eq(operation.argv[5], "PermitLocalCommand=no", "disable LocalCommand")
				eq(operation.timeout_ms, 10000, "bounded parse timeout")
				local destination = operation.argv[#operation.argv]
				table.insert(destinations, destination)
				local receipt = type(receipts) == "function" and receipts(destination, #destinations) or receipts[destination]
				job.accept(receipt)
				end
			else
				eq(operation.kind, "read", "only read or process operations")
				eq(operation.limit, 65536, "bounded file read")
				table.insert(reads, operation.path)
				local text = files[operation.path]
				job.accept({ ok = text ~= nil, text = text })
			end
		end
		local result = job.result()
		check(#result.candidates <= 6, "bounded authentication list")
		check(type(result.notice) == "string" and #result.notice < 1600, "bounded public notice")
		check(not string.find(result.notice, "SECRET", 1, true), "no raw diagnostic or config disclosure")
		for _, candidate in ipairs(result.candidates) do
			check(#candidate.destination <= 255, "bounded destination")
			check(candidate.source == "saved" or candidate.source == "config" or candidate.source == "address", "fixed source vocabulary")
		end
		eq(job.next(), nil, "finished job stays finished")
		check(not pcall(function() job.accept({}) end), "late receipt rejected")
		return result, destinations, reads
	end
	local function candidate(result, index, destination, source)
		check(result.candidates[index] ~= nil, "expected candidate exists")
		eq(result.candidates[index].destination, destination, "destination ordering")
		eq(result.candidates[index].source, source, "candidate provenance")
	end
	local function contains(values, expected)
		for _, value in ipairs(values) do if value == expected then return true end end
		return false
	end

	local root = "C:\\Users\\测试 User\\.ssh\\config"
	local include = "C:/Users/测试 User/.ssh/includes/build hosts.conf"
	local nested = "/etc/ssh/config.d/team hosts.conf"
	local files = {
		[root] = '# Host ignored-comment\r\nHost="build-alias" alternate wild* question? [abc]\r\n  HostName 192.0.2.8\r\n  IdentityFile "SECRET-KEY"\r\nHost unrelated\r\n  HostName 192.0.2.99\r\nInclude "includes/*.conf"\r\nHost !negated\r\n',
		[include] = "Host 'included-alias' # trailing comment\r\n  ProxyJump gateway\r\nMatch host build-alias\r\n Include nested.conf\r\n",
		[nested] = "Host=nested-alias\n  User deploy\n",
	}
	local receipts = {
		["192.0.2.8"] = parsed("192.0.2.8", "local-user", 22, { root, include }),
		["build-alias"] = parsed("192.0.2.8", "deploy", 2222, { root, nested }),
		["alternate"] = parsed("192.0.2.8", "other-account", 2200, { root }),
		["unrelated"] = parsed("192.0.2.99", "deploy", 2222, { root }),
		["included-alias"] = parsed("192.0.2.8", "deploy", 22, { include }),
		["nested-alias"] = parsed("192.0.2.8", "deploy", 22, { nested }),
	}
	local result, destinations, reads = drive({ address = "192.0.2.8", name = "Different Tern Name" }, {}, receipts, files)
	candidate(result, 1, "build-alias", "config")
	candidate(result, 2, "alternate", "config")
	candidate(result, 3, "included-alias", "config")
	candidate(result, 4, "nested-alias", "config")
	candidate(result, 5, "192.0.2.8", "address")
	eq(#result.candidates, 5, "unrelated alias not authenticated")
	check(contains(destinations, "unrelated"), "unrelated alias only parsed by ssh -G")
	check(not contains(destinations, "Different Tern Name"), "display label never used as arbitrary destination")
	check(not contains(destinations, "wild*") and not contains(destinations, "question?") and not contains(destinations, "!negated"), "patterns and negations excluded")
	eq(#reads, 3, "Include files come from each native trace, deduplicated")
	check(contains(reads, root) and contains(reads, include) and contains(reads, nested), "Windows Unicode spaces and POSIX paths preserved")

	result = drive({ address = "192.0.2.8" }, { hosts = { ["192.0.2.8"] = "saved-alias" } }, receipts, files)
	candidate(result, 1, "saved-alias", "saved")
	candidate(result, 2, "build-alias", "config")
	candidate(result, 6, "192.0.2.8", "address")

	local explicit = "ssh://deploy@192.0.2.8:2222"
	receipts[explicit] = parsed("192.0.2.8", "deploy", 2222, { root, include })
	result = drive({ address = explicit }, {}, receipts, files)
	candidate(result, 1, "build-alias", "config")
	candidate(result, 2, explicit, "address")
	eq(#result.candidates, 2, "explicit native user and port constrain association")

	local opaque = string.rep("a1", 32)
	receipts["tern-omp-discovery.invalid"] = parsed("tern-omp-discovery.invalid", "local-user", 22, { root })
	result, destinations = drive({ address = opaque, name = "build-alias" }, {}, receipts, files)
	candidate(result, 1, "build-alias", "config")
	eq(#result.candidates, 1, "opaque identity uses only existing exact alias name")
	check(string.find(result.notice, "display name only", 1, true), "name clue carries explicit review warning")
	check(not contains(destinations, opaque), "opaque node id never sent to ssh")
	result, destinations = drive({ address = opaque, name = "new-unconfigured-name" }, {}, receipts, files)
	eq(#result.candidates, 0, "unknown display name cannot become an authentication candidate")
	check(not contains(destinations, "new-unconfigured-name"), "unconfigured label never parsed")
	result = drive({ name = "Different local naming" }, {}, receipts, files)
	eq(#result.candidates, 0, "client naming differences safely require manual input")

	result = drive({ address = "192.0.2.8" }, {}, {}, {})
	candidate(result, 1, "192.0.2.8", "address")
	check(string.find(result.notice, "Cannot start OpenSSH", 1, true), "missing SSH is actionable")
	result = drive({ address = opaque }, {}, {}, {})
	eq(#result.candidates, 0, "missing SSH cannot invent opaque address")
	result = drive({ address = "192.0.2.8" }, {}, { ["192.0.2.8"] = { status = 255, stdout = "", stderr = "SECRET illegal config" } }, {})
	check(string.find(result.notice, "could not parse", 1, true), "invalid configuration notice is sanitized")
	result = drive({ address = "192.0.2.8" }, {}, { ["192.0.2.8"] = { status = 0, stdout = "SECRET malformed output", stderr = "" } }, {})
	eq(#result.candidates, 1, "malformed effective output cannot create aliases")
	result = drive({ address = "192.0.2.8" }, {}, { ["192.0.2.8"] = { status = 0, stdout = "", stderr = "", timed_out = true } }, {})
	check(string.find(result.notice, "could not parse", 1, true), "timeout stays bounded and actionable")

	local aliases = {}
	for index = 1, 80 do table.insert(aliases, "alias-" .. tostring(index)) end
	local capFiles = { ["/tmp/config"] = "Host " .. table.concat(aliases, " ") .. "\n" }
	result, destinations = drive({ address = "192.0.2.8" }, {}, function()
		return parsed("192.0.2.8", "deploy", 22, { "/tmp/config" })
	end, capFiles)
	eq(#destinations, 65, "64 aliases plus native seed cap")
	eq(#result.candidates, 6, "candidate cap reserves native fallback")
	candidate(result, 1, "alias-1", "config")
	candidate(result, 6, "192.0.2.8", "address")
	check(string.find(result.notice, "safety limit", 1, true), "incomplete scan clearly disclosed")

	local paths = {}
	local manyFiles = {}
	for index = 1, 20 do
		local path = "/tmp/config-" .. tostring(index)
		table.insert(paths, path)
		manyFiles[path] = "# empty config\n"
	end
	result, _, reads = drive({ address = "192.0.2.8" }, {}, { ["192.0.2.8"] = parsed("192.0.2.8", "user", 22, paths) }, manyFiles)
	eq(#reads, 16, "file count cap")
	check(string.find(result.notice, "safety limit", 1, true), "file count truncation disclosed")
	for _, path in ipairs(paths) do manyFiles[path] = "#" .. string.rep("x", 59998) .. "\n" end
	result, _, reads = drive({ address = "192.0.2.8" }, {}, { ["192.0.2.8"] = parsed("192.0.2.8", "user", 22, paths) }, manyFiles)
	eq(#reads, 5, "aggregate byte budget stops further reads")
	result = drive({ address = "192.0.2.8" }, {}, { ["192.0.2.8"] = parsed("192.0.2.8", "user", 22, { "/tmp/config" }) }, { ["/tmp/config"] = string.rep("x", 65536) })
	check(string.find(result.notice, "safety limit", 1, true), "possibly truncated file never treated as complete")
	result = drive({ address = "192.0.2.8" }, {}, { ["192.0.2.8"] = { status = 0, stdout = string.rep("x", 65537), stderr = "SECRET" } }, {})
	check(string.find(result.notice, "safety limit", 1, true), "oversized process output bounded")
	result = drive({ address = "192.0.2.8" }, {}, { ["192.0.2.8"] = parsed("192.0.2.8", "user", 22, { "/tmp/unreadable" }) }, {})
	check(string.find(result.notice, "could not be read", 1, true), "unreadable files disclosed")

	local lexical = "/tmp/quoted config"
	result, destinations = drive({ address = "192.0.2.8" }, {}, function()
		return parsed("192.0.2.8", "user", 22, { lexical })
	end, { [lexical] = "HOST = \"quoted-alias\" 'single-alias' # ignored\r\nhOsT=equal-alias\r\nHost * !excluded q? [ab] \"space alias\" unicode-测试\r\nHost \"unterminated\r\nHostName not-a-host-line\r\n" })
	candidate(result, 1, "quoted-alias", "config")
	candidate(result, 2, "single-alias", "config")
	candidate(result, 3, "equal-alias", "config")
	eq(#destinations, 4, "only safe literal aliases parsed; no option or Unicode destination guessing")
	local unc = "\\\\server\\share\\SSH 配置\\config"
	local posix = "/home/测试 person/.ssh/config"
	result, _, reads = drive({ address = "192.0.2.8" }, {}, {
		["192.0.2.8"] = parsed("192.0.2.8", "user", 22, { unc, posix, "relative/config", "/tmp/bad\npath" }),
	}, { [unc] = "# empty", [posix] = "# empty" })
	eq(#reads, 2, "only absolute control-free paths read")
	eq(reads[1], unc, "OpenSSH escaped UNC backslashes decoded once")
	eq(reads[2], posix, "OpenSSH octal UTF-8 bytes decoded to filesystem path")
	result = drive({ address = "192.0.2.8", name = "unrelated" }, {}, receipts, files)
	eq(#result.candidates, 5, "display name cannot override contradictory native address")
	for _, exclusion in ipairs({ "!build-alias", "!build-*", "!other-host" }) do
		result, destinations = drive({ address = opaque, name = "build-alias" }, {}, function(destination)
			-- Excluded blocks leave only defaults in native ssh -G output.
			return parsed(destination, "local-user", 22, { "/tmp/excluded-config" })
		end, { ["/tmp/excluded-config"] = "Host build-alias " .. exclusion .. "\n HostName 192.0.2.8\n" })
		eq(#result.candidates, 0, "negated Host declaration cannot become a name-only candidate")
		check(not contains(destinations, "build-alias"), "ambiguous excluded declaration not parsed as a literal alias")
		check(string.find(result.notice, "exclusions were skipped", 1, true), "conservative exclusion handling disclosed")
	end
	result = drive({ address = opaque, name = "build-alias" }, {}, function(destination)
		return parsed(destination, "local-user", 22, { "/tmp/excluded-config" })
	end, { ["/tmp/excluded-config"] = "Host build-alias !build-alias\nHost build-alias\n HostName 192.0.2.8\n" })
	candidate(result, 1, "build-alias", "config")
	eq(#result.candidates, 1, "independent unexcluded Host declaration still permits a name clue")
	local msysUser = "/d/Home/测试 User/.ssh/config"
	local msysSystem = "/etc/ssh/ssh_config"
	local winUser = "D:\\Home\\测试 User\\.ssh\\config"
	local winSystem = "D:\\Tools\\Git\\etc\\ssh\\ssh_config"
	local msysReceipts = {
		["192.0.2.8"] = parsed("192.0.2.8", "deploy", 22, { msysUser, msysSystem }),
		["user-profile"] = parsed("192.0.2.8", "deploy", 22, { msysUser, msysSystem }),
		["system-profile"] = parsed("192.0.2.8", "deploy", 22, { msysUser, msysSystem }),
	}
	local toolchain = {
		platform = "windows",
		location = { status = 0, stdout = "D:\\Tools\\Git\\usr\\bin\\ssh.exe\r\nC:\\Windows\\System32\\OpenSSH\\ssh.exe\r\n", stderr = "", timed_out = false },
		converter = "D:\\Tools\\Git\\usr\\bin\\cygpath.exe",
		conversions = { [msysUser] = winUser, [msysSystem] = winSystem },
	}
	result, _, reads = drive({ address = "192.0.2.8" }, {}, msysReceipts, { [winUser] = "Host user-profile", [winSystem] = "Host system-profile" }, toolchain)
	candidate(result, 1, "user-profile", "config")
	candidate(result, 2, "system-profile", "config")
	check(contains(reads, winUser) and contains(reads, winSystem), "MSYS user and system configuration reach native filesystem paths")
	check(not contains(reads, msysUser) and not contains(reads, msysSystem), "Windows never reads MSYS paths as current-drive paths")
	result, _, reads = drive({ address = "192.0.2.8" }, {}, msysReceipts, {}, { platform = "windows", location = toolchain.location, converter = toolchain.converter })
	eq(#reads, 0, "failed path conversion cannot authorize a guessed filesystem read")
	candidate(result, 1, "192.0.2.8", "address")
	check(result.notice:find("could not be read", 1, true), "unavailable path conversion is disclosed")
	result = drive({ address = "192.0.2.8" }, {}, { ["192.0.2.8"] = parsed("192.0.2.8", "user", 22, { winUser }), ["native-profile"] = parsed("192.0.2.8", "user", 22, { winUser }) }, { [winUser] = "Host native-profile" }, { platform = "windows" })
	candidate(result, 1, "native-profile", "config")
	result, _, reads = drive({ address = "192.0.2.8" }, {}, { ["192.0.2.8"] = parsed("192.0.2.8", "user", 22, { msysUser }), ["posix-profile"] = parsed("192.0.2.8", "user", 22, { msysUser }) }, { [msysUser] = "Host posix-profile" }, { platform = "linux" })
	candidate(result, 1, "posix-profile", "config")
	eq(reads[1], msysUser, "a real POSIX /d directory is not reinterpreted as a Windows drive")
	print("Shipped SSH discovery assertions passed: " .. tostring(passed))
end
