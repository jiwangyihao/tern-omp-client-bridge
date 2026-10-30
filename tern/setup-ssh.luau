-- SPDX-License-Identifier: MPL-2.0
-- Pure, bounded discovery: the caller executes one native operation per tick.
-- The controller owns wall-clock deadlines; this module bounds operation counts and bytes.
-- OpenSSH owns Include/Match/connection semantics; we only enumerate literal Host names.
local target = require("./setup-target")
local Discovery = {}

local FILE_LIMIT = 65536
local BYTE_LIMIT = 262144
local FILE_COUNT = 16
local ALIAS_COUNT = 64
local PROCESS_COUNT = 84
local OPERATION_COUNT = 112
local CANDIDATE_COUNT = 6
local OUTPUT_LIMIT = 65536
local messages = {
	limit = "SSH discovery reached a safety limit and may be incomplete. Enter your SSH Host alias manually if needed.",
	missing = "Cannot start OpenSSH for discovery. Install ssh and make it available to Tern, or enter your SSH destination manually.",
	config = "OpenSSH could not parse part of the local configuration. Discovery may be incomplete; check your configuration or enter an SSH destination manually.",
	read = "Some OpenSSH configuration files could not be read. Discovery may be incomplete; enter your SSH Host alias manually if needed.",
	patterns = "Host declarations containing exclusions were skipped conservatively. Discovery may be incomplete; enter your SSH Host alias manually if needed.",
	naming = "A local SSH alias matches the Tern display name only. Review the destination: this is not proof that the SSH and Tern hosts are the same machine.",
	empty = "No associated local SSH alias was found. Enter the SSH Host alias used on this client device manually.",
	review = "Review the SSH destination before installation. Matching configuration or successful SSH access does not prove it is the same machine as the Tern host.",
}

local function foldedHost(value)
	return string.lower((string.gsub(value, "%.$", "")))
end

local function explicitParts(destination)
	local authority = string.gsub(destination, "^ssh://", "")
	local user, host = string.match(authority, "^([^@]+)@(.+)$")
	host = host or authority
	local port = string.match(host, "^%[[^%]]+%]:(%d+)$")
		or string.match(host, "^[^:]+:(%d+)$")
	return user, port and tonumber(port) or nil
end

local function effective(text)
	local values = {}
	for line in string.gmatch(text .. "\n", "([^\n]*)\n") do
		local key, value = string.match(line, "^([%a]+)%s+([^%s]+)%s*$")
		if key == "hostname" or key == "user" or key == "port" then
			if values[key] ~= nil then return nil end
			values[key] = value
		end
	end
	local port = values.port and tonumber(values.port)
	if not values.hostname or #values.hostname > 255 or not values.user or #values.user > 255
		or not values.port or not string.match(values.port, "^%d+$") or not port or port < 1 or port > 65535 then return nil end
	return { hostname = foldedHost(values.hostname), user = values.user, port = port }
end

-- Tokenization is deliberately limited to Host arguments, never connection options.
local function hostTokens(line)
	local keyword, rest = string.match(line, "^%s*([%a]+)(.*)$")
	if not keyword or string.lower(keyword) ~= "host" or not string.match(rest, "^[%s=]") then return nil end
	rest = string.gsub(rest, "^%s*=?%s*", "")
	local tokens, token, quote, escaped = {}, {}, nil, false
	local function flush()
		if #token > 0 then table.insert(tokens, table.concat(token)); token = {} end
	end
	for index = 1, #rest do
		local char = string.sub(rest, index, index)
		if escaped then
			table.insert(token, char)
			escaped = false
		elseif char == "\\" then
			escaped = true
		elseif quote then
			if char == quote then quote = nil else table.insert(token, char) end
		elseif char == '"' or char == "'" then
			quote = char
		elseif char == "#" then
			break
		elseif string.match(char, "%s") then
			flush()
		else
			table.insert(token, char)
		end
	end
	if quote or escaped then return nil end
	flush()
	return tokens
end

local function literalAlias(value)
	return #value <= 255 and not string.find(value, "[%*%?!@:/\\%[%]]")
		and target.candidate(value) == value
end

-- OpenSSH's log escaping doubles backslashes and octal-escapes UTF-8 bytes.
-- Decode once before native I/O; a Windows trace is not already a filesystem path.
local function tracePath(value)
	if #value > 16384 then return nil end
	local parts, index = {}, 1
	while index <= #value do
		local char = string.sub(value, index, index)
		if char == "\\" and string.sub(value, index + 1, index + 1) == "\\" then
			table.insert(parts, "\\")
			index += 2
		elseif char == "\\" and string.match(string.sub(value, index + 1, index + 3), "^[0-3][0-7][0-7]$") then
			table.insert(parts, string.char(tonumber(string.sub(value, index + 1, index + 3), 8)))
			index += 4
		else
			table.insert(parts, char)
			index += 1
		end
	end
	return table.concat(parts)
end

local function configPath(value, native)
	if not native then value = tracePath(value) end
	if not value then return nil end
	if #value == 0 or #value > 4096 or string.find(value, "%c") then return nil end
	if string.sub(value, 1, 1) == "/" then return value, value end
	if string.match(value, "^%a:[/\\]") or string.sub(value, 1, 2) == "\\\\" then
		return value, string.lower((string.gsub(value, "\\", "/")))
	end
	return nil
end

function Discovery.new(selection, saved, platform)
	selection = type(selection) == "table" and selection or {}
	local address = target.candidate(selection.address)
	local savedHosts = type(saved) == "table" and type(saved.hosts) == "table" and saved.hosts or {}
	local savedDestination = type(selection.address) == "string" and target.candidate(savedHosts[selection.address]) or nil
	local name = type(selection.name) == "string" and #selection.name <= 255 and string.lower(selection.name) or nil
	local seed = address or savedDestination or "tern-omp-discovery.invalid"
	local requiredUser, requiredPort = explicitParts(address or savedDestination or seed)
	local files, fileSeen, aliases, aliasSeen, matches = {}, {}, {}, {}, {}
	local fileIndex, aliasIndex, bytes, processes, operations = 1, 1, 0, 0, 0
	local pending, pendingAlias, anchor, finished, output = nil, nil, nil, false, nil
	local seeded, halted, naming = false, false, false
	local windows = platform == "windows" or platform == "win32"
	local located, sshExecutable, converted = false, nil, {}
	local notices, noticeSeen = {}, {}
	local job = {}

	local function notice(key)
		if not noticeSeen[key] then noticeSeen[key] = true; table.insert(notices, messages[key]) end
	end

	local function trace(stderr)
		for line in string.gmatch(stderr .. "\n", "([^\n]*)\n") do
			line = string.gsub(line, "\r$", "")
			local raw = string.match(line, "^debug1: Reading configuration data (.+)$")
			if raw then
				local path, key = configPath(raw)
				if not path then
					notice("read")
				elseif not fileSeen[key] then
					if #files >= FILE_COUNT then notice("limit") else fileSeen[key] = true; table.insert(files, path) end
				end
			end
		end
	end

	local function finish()
		local candidates, seen = {}, {}
		local function add(destination, source)
			if destination and not seen[destination] then
				if #candidates >= CANDIDATE_COUNT then notice("limit"); return end
				seen[destination] = true
				table.insert(candidates, { destination = destination, source = source })
			end
		end
		add(savedDestination, "saved")
		-- Reserve one slot for the existing native address while preferring config aliases.
		local configLimit = CANDIDATE_COUNT - (address and address ~= savedDestination and 1 or 0)
		for _, alias in ipairs(matches) do
			if not seen[alias] then
				if #candidates < configLimit or alias == address then add(alias, "config") else notice("limit") end
			end
		end
		add(address, "address")
		if naming then notice("naming") end
		if #candidates == 0 then notice("empty") else notice("review") end
		output = { candidates = candidates, notice = table.concat(notices, " ") }
		finished = true
	end

	function job.next()
		assert(pending == nil, "Accept the outstanding SSH discovery operation first")
		if finished then return nil end
		if halted or operations >= OPERATION_COUNT then
			if not halted then notice("limit") end
			finish()
			return nil
		end
		local destination
		if not seeded then
			seeded = true
			destination = seed
		elseif fileIndex <= #files then
			if bytes >= BYTE_LIMIT then
				notice("limit")
				fileIndex = #files + 1
			else
				local file = files[fileIndex]
				local needsConversion = windows and file:sub(1, 1) == "/" and file:sub(1, 2) ~= "//"
				if needsConversion and not located then
					pending = { kind = "process", purpose = "locate", argv = { "where.exe", "ssh.exe" }, timeout_ms = 10000, label = "Locating this device’s SSH toolchain" }
				elseif needsConversion and converted[file] == nil then
					if not sshExecutable then notice("read"); fileIndex += 1; return job.next() end
					local converter = sshExecutable:gsub("[^/\\]+$", "cygpath.exe")
					pending = { kind = "process", purpose = "convert", path = file, argv = { converter, "-w", file }, timeout_ms = 10000, label = "Resolving SSH configuration paths" }
				elseif needsConversion and converted[file] == false then
					fileIndex += 1
					return job.next()
				else
					pending = { kind = "read", path = needsConversion and converted[file] or file, limit = FILE_LIMIT }
					fileIndex += 1
				end
			end
		end
		if not destination and not pending then
			if aliasIndex <= #aliases then
				destination = aliases[aliasIndex]
				pendingAlias = destination
				aliasIndex += 1
			else
				finish()
				return nil
			end
		end
		if destination then
			pending = {
				kind = "process", timeout_ms = 10000, label = "Reading local OpenSSH configuration",
				argv = { "ssh", "-G", "-v", "-o", "PermitLocalCommand=no", "-o", "BatchMode=yes", destination },
			}
		end
		if pending and pending.kind == "process" then
			if processes >= PROCESS_COUNT then pending, pendingAlias = nil, nil; notice("limit"); finish(); return nil end
			processes += 1
		end
		operations += 1
		return pending
	end

	function job.accept(result)
		assert(pending ~= nil and not finished, "No SSH discovery operation is pending")
		local operation, alias = pending, pendingAlias
		pending, pendingAlias = nil, nil
		if operation.purpose == "locate" then
			located = true
			if type(result) == "table" and result.status == 0 and not result.timed_out and type(result.stdout) == "string" and #result.stdout <= OUTPUT_LIMIT then
				local path = result.stdout:match("^([^\r\n]+)")
				local normalized = path and path:gsub("\\", "/")
				if normalized and (normalized:match("^%a:/") or normalized:sub(1, 2) == "//") and normalized:lower():match("/ssh%.exe$") then
					sshExecutable = configPath(path, true)
				end
			end
			if not sshExecutable then notice("read") end
			return
		elseif operation.purpose == "convert" then
			converted[operation.path] = false
			if type(result) == "table" and result.status == 0 and not result.timed_out and type(result.stdout) == "string" and #result.stdout <= OUTPUT_LIMIT then
				local path = result.stdout:gsub("[\r\n]+$", "")
				local normalized = path:gsub("\\", "/")
				if normalized:match("^%a:/") or normalized:sub(1, 2) == "//" then
					local native, key = configPath(path, true)
					if native then
						if not fileSeen[key] then converted[operation.path] = native; fileSeen[key] = true end
						return
					end
				end
			end
			notice("read")
			return
		end
		if operation.kind == "read" then
			if type(result) ~= "table" or result.ok ~= true or type(result.text) ~= "string" then notice("read"); return end
			local text = result.text
			if #text >= FILE_LIMIT or bytes + #text > BYTE_LIMIT then notice("limit"); bytes = BYTE_LIMIT; return end
			bytes += #text
			if string.find(text, "\000", 1, true) then notice("read"); return end
			for line in string.gmatch(text .. "\n", "([^\n]*)\n") do
				local tokens = hostTokens(line)
				if tokens then
					-- A positive token beside !pattern need not be an applicable Host alias.
					-- Do not emulate OpenSSH pattern matching or admit it on display name alone.
					local excluded = false
					for _, value in ipairs(tokens) do
						if string.sub(value, 1, 1) == "!" then excluded = true; break end
					end
					for _, value in ipairs(tokens) do
						if literalAlias(value) then
							if excluded then notice("patterns"); continue end
							local key = string.lower(value)
							if not aliasSeen[key] then
								if #aliases >= ALIAS_COUNT then notice("limit") else aliasSeen[key] = true; table.insert(aliases, value) end
							end
						end
					end
				end
			end
			return
		end
		if result == nil or (type(result) == "table" and (result.status == -1 or result.status == 127)) then
			notice("missing"); halted = true; return
		end
		if type(result) ~= "table" or result.timed_out == true or result.status ~= 0
			or type(result.stdout) ~= "string" or type(result.stderr) ~= "string" then
			notice("config")
			if alias == nil then halted = true end
			return
		end
		if #result.stdout > OUTPUT_LIMIT or #result.stderr > OUTPUT_LIMIT then notice("limit"); halted = true; return end
		trace(result.stderr)
		local parsed = effective(result.stdout)
		if not parsed then notice("config"); if alias == nil then halted = true end; return end
		if alias == nil then
			-- A synthetic seed discovers file locations only; it is never a host identity.
			if address or savedDestination then anchor = parsed end
			return
		end
		local sameAddress = anchor and parsed.hostname == anchor.hostname
			and (requiredUser == nil or parsed.user == requiredUser)
			and (requiredPort == nil or parsed.port == requiredPort)
		local sameName = address == nil and name ~= nil and string.lower(alias) == name
		if sameAddress or sameName then
			table.insert(matches, alias)
			if sameName and not sameAddress then naming = true end
		end
	end

	function job.result()
		assert(finished, "SSH discovery has not finished")
		return output
	end

	return job
end

return Discovery
