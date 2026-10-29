-- SPDX-License-Identifier: MPL-2.0
-- Pure setup targeting and a fixed, read-only SSH protocol. No native host is an SSH credential.
local target = {}

local function safeText(value)
	return type(value) == "string" and #value > 0 and #value <= 255 and not string.find(value, "[%s%c]")
end

local function ipv4(value)
	local count = 0
	for part in string.gmatch(value, "[^.]+") do
		if not string.match(part, "^%d+$") or #part > 3 or tonumber(part) > 255 then return false end
		count += 1
	end
	return count == 4 and not string.find(value, "..", 1, true) and string.sub(value, 1, 1) ~= "." and string.sub(value, -1) ~= "."
end

local function ipv6(value)
	if not string.find(value, ":", 1, true) or string.find(value, "[^%x:%.]") then return false end
	local compressed = string.find(value, "::", 1, true)
	if string.find(value, ":::", 1, true) or (compressed and string.find(value, "::", compressed + 2, true)) then return false end
	if not compressed and (string.sub(value, 1, 1) == ":" or string.sub(value, -1) == ":") then return false end
	if compressed and ((string.sub(value, 1, 1) == ":" and compressed ~= 1) or (string.sub(value, -1) == ":" and compressed ~= #value - 1)) then return false end
	local groups = 0
	for part in string.gmatch(value, "[^:]+") do
		if string.find(part, ".", 1, true) then
			if not ipv4(part) or string.sub(value, -#part) ~= part then return false end
			groups += 2
		else
			if #part > 4 or not string.match(part, "^%x+$") then return false end
			groups += 1
		end
	end
	return (compressed ~= nil and groups < 8) or (compressed == nil and groups == 8)
end

local function hostname(value)
	if #value == 64 and string.match(value, "^%x+$") then return false end
	if not string.match(value, "^[%w_][%w_.%-]*$") or string.sub(value, -1) == "-" then return false end
	if string.find(value, "..", 1, true) then return false end
	for label in string.gmatch(value, "[^.]+") do
		if #label > 63 or string.sub(label, 1, 1) == "-" or string.sub(label, -1) == "-" then return false end
	end
	if string.match(value, "^[%d.]+$") and string.find(value, ".", 1, true) then return ipv4(value) end
	return true
end

local function portValid(value)
	return string.match(value, "^%d+$") ~= nil and #value <= 5 and tonumber(value) >= 1 and tonumber(value) <= 65535
end

function target.candidate(address)
	if not safeText(address) then return nil end
	local uri = string.sub(address, 1, 6) == "ssh://"
	local authority = uri and string.sub(address, 7) or address
	local user, host = string.match(authority, "^([^@]+)@(.+)$")
	if user then
		if not string.match(user, "^[%w_][%w_.%-]*$") then return nil end
	else
		host = authority
	end
	local prefix = user and (user .. "@") or ""
	local port = nil
	local bracketed = string.sub(host, 1, 1) == "["
	if bracketed then
		local inner, suffix = string.match(host, "^%[([^%]]+)%](.*)$")
		if not inner or not ipv6(inner) then return nil end
		if suffix ~= "" then
			port = string.match(suffix, "^:(%d+)$")
			if not port or not portValid(port) then return nil end
		end
		host = inner
	elseif string.find(host, ":", 1, true) then
		if ipv6(host) then
			-- SSH URI requires brackets; plain OpenSSH destinations accept bare IPv6.
			if uri then return nil end
			return address
		end
		local name, number = string.match(host, "^([^:]+):(%d+)$")
		if not name or not portValid(number) then return nil end
		host, port = name, number
	end
	if not bracketed and not hostname(host) then return nil end
	if uri or port or bracketed then
		local normalized = "ssh://" .. prefix .. (bracketed and ("[" .. host .. "]") or host) .. (port and (":" .. port) or "")
		return #normalized <= 255 and normalized or nil
	end
	return prefix .. host
end

function target.validHost(value)
	-- Backend passes exactly one destination argument: raw host:port is not an SSH port option.
	return type(value) == "string" and target.candidate(value) == value
end

local function connected(host)
	return type(host) == "table" and type(host.id) == "number" and host.id == host.id
		and host.kind == "remote" and host.state == "connected"
		and (host.address == nil or type(host.address) == "string")
end

function target.choices(hosts, current)
	local rows = {}
	if type(hosts) == "table" then
		for _, host in ipairs(hosts) do
			if connected(host) then
				local name = type(host.name) == "string" and host.name or "Connected remote host"
				local isCurrent = type(current) == "table" and current.id == host.id
				local row = { label = name, detail = (isCurrent and "Current session · Connected · " or "Connected · ") .. (host.address or "SSH address required"), selection = { id = host.id, name = name, address = host.address } }
				if isCurrent then table.insert(rows, 1, row) else table.insert(rows, row) end
			end
		end
	end
	table.insert(rows, { label = "Enter SSH address manually", manual = true })
	return rows
end

function target.selectionValid(selection, hosts)
	if selection == nil or (type(selection) == "table" and selection.manual == true and selection.id == nil) then return true end
	if type(selection) ~= "table" or type(hosts) ~= "table" then return false end
	for _, host in ipairs(hosts) do
		if connected(host) and host.id == selection.id and host.address == selection.address then return true end
	end
	return false
end

-- Protocol markers contain no hostname, username, HOME, paths, or diagnostics.
local probe = [=[set -eu
fail() { printf 'TERN_OMP_SSH_PREFLIGHT_V1\tERROR\t%s\n' "$2"; exit "$1"; }
case "${SHELL:-/bin/sh}" in */sh|*/bash|*/dash|*/zsh|*/ksh|*/mksh) ;; *) fail 23 shell;; esac
for tool in sh tar mkdir chmod mv uname; do command -v "$tool" >/dev/null 2>&1 || fail 21 tools; done
system=$(uname -s) || fail 20 platform
arch=$(uname -m) || fail 20 platform
case "$system" in Linux|Darwin) ;; *) fail 20 platform;; esac
case "$arch" in x86_64|amd64|aarch64|arm64) ;; *) fail 20 platform;; esac
case "${HOME:-}" in /*) ;; *) fail 22 home;; esac
test -d "$HOME" || fail 22 home
printf 'TERN_OMP_SSH_PREFLIGHT_V1\t%s\t%s\n' "$system" "$arch"
]=]

function target.preflightArgs(host)
	assert(target.validHost(host), "A validated SSH destination is required")
	-- Quoting is only for this constant remote program. The destination remains a direct argv item.
	local command = "sh -c '" .. string.gsub(probe, "'", "'\\''") .. "'"
	return {
		"ssh", "-T", "-n", "-o", "BatchMode=yes", "-o", "ForwardAgent=no",
		"-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
		"-o", "ClearAllForwardings=yes", "-o", "ControlPath=none", "-o", "PermitLocalCommand=no",
		"-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1", host, command,
	}
end

local messages = {
	authentication = "SSH authentication failed. Configure passwordless SSH for this destination in your terminal, then retry.",
	host_key = "SSH host-key verification failed. Independently verify and trust the host key in your terminal, then retry. Bridge did not change SSH trust.",
	network = "Cannot reach this SSH destination. Check the address, port, VPN or network, and SSH service, then retry.",
	timeout = "SSH checking timed out. Check the address, network, and SSH service, then retry.",
	unsupported_platform = "This host is unsupported. Setup requires Linux or macOS on x86-64 or ARM64.",
	missing_tools = "The remote host is missing required tools. Make sh, tar, mkdir, chmod, mv, and uname available, then retry.",
	invalid_home = "The remote HOME is unavailable. Configure an existing absolute home directory for this SSH account, then retry.",
	unsupported_shell = "The remote login shell is unsupported. Configure a POSIX-compatible shell for noninteractive SSH, then retry.",
	missing_ssh = "Cannot start the SSH client. Install OpenSSH and make ssh available to Tern, then retry.",
	invalid_output = "SSH did not return the exact setup probe response. Disable noninteractive shell banners or wrappers and retry.",
	failed = "SSH checking failed. Verify trusted, passwordless access to this destination in your terminal, then retry.",
}

local function failure(code)
	return { ok = false, code = code, message = messages[code] }
end

local function includes(text, needle)
	return string.find(text, needle, 1, true) ~= nil
end

function target.preflightResult(result)
	-- A failed native process launch has no result. Never publish its raw error text.
	if result == nil then return failure("missing_ssh") end
	if type(result) ~= "table" then return failure("failed") end
	if result.timed_out == true then return failure("timeout") end
	if type(result.status) ~= "number" or type(result.stdout) ~= "string" or type(result.stderr) ~= "string" then return failure("failed") end
	local stdout, stderr = result.stdout, result.stderr
	if result.status == 0 then
		if #stdout > 128 then return failure("invalid_output") end
		local system, arch = string.match(stdout, "^TERN_OMP_SSH_PREFLIGHT_V1\t([%w_]+)\t([%w_]+)\n$")
		if (system == "Linux" or system == "Darwin") and (arch == "x86_64" or arch == "amd64" or arch == "aarch64" or arch == "arm64") then
			return { ok = true, system = system, arch = arch }
		end
		return failure("invalid_output")
	end
	local markers = {
		{ status = 20, marker = "platform", code = "unsupported_platform" },
		{ status = 21, marker = "tools", code = "missing_tools" },
		{ status = 22, marker = "home", code = "invalid_home" },
		{ status = 23, marker = "shell", code = "unsupported_shell" },
	}
	for _, item in ipairs(markers) do
		if result.status == item.status and stdout == "TERN_OMP_SSH_PREFLIGHT_V1\tERROR\t" .. item.marker .. "\n" then return failure(item.code) end
	end
	-- Classification reads bounded diagnostic bytes; public text always comes from the fixed table.
	local diagnostic = string.lower(string.sub(stderr, 1, 8192))
	if includes(diagnostic, "host key verification failed") or includes(diagnostic, "remote host identification has changed") or includes(diagnostic, "host key is known") then return failure("host_key") end
	if includes(diagnostic, "permission denied") or includes(diagnostic, "authentication failed") or includes(diagnostic, "too many authentication failures") or includes(diagnostic, "no supported authentication methods") then return failure("authentication") end
	if includes(diagnostic, "connection timed out") or includes(diagnostic, "operation timed out") then return failure("timeout") end
	if includes(diagnostic, "could not resolve hostname") or includes(diagnostic, "name or service not known") or includes(diagnostic, "connection refused") or includes(diagnostic, "no route to host") or includes(diagnostic, "network is unreachable") or includes(diagnostic, "connection reset") or includes(diagnostic, "connection closed") then return failure("network") end
	if (result.status == 127 or result.status == -1) and (includes(diagnostic, "ssh: not found") or includes(diagnostic, "ssh: command not found") or (includes(diagnostic, "ssh") and includes(diagnostic, "no such file or directory"))) then return failure("missing_ssh") end
	if result.status == 127 and (includes(diagnostic, "sh: not found") or includes(diagnostic, "sh: command not found")) then return failure("missing_tools") end
	return failure("failed")
end

return target
