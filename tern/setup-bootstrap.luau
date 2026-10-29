-- SPDX-License-Identifier: MPL-2.0
-- Bounded client-side source preparation only. Execution uses the existing host transport.
local M = {}
local files = {
	{ source = 'tern/setup-ui/plugin.toml', target = 'package/plugin.toml' },
	{ source = 'tern/setup-ui/host.luau', target = 'package/host.luau' },
	{ source = 'tern/setup-ui/view.luau', target = 'package/view.luau' },
	{ source = 'tern/setup-ui/panel.css', target = 'package/panel.css' },
	{ source = 'tern/setup-ui/.bridge-setup-owned', target = 'package/.bridge-setup-owned' },
	{ source = 'scripts/setup-ui-remote.sh', target = 'install.sh' },
}
local function quote(value)
	return "'" .. value:gsub("'", "'\\''") .. "'"
end
local failure = 'The native setup UI package is missing, invalid, or exceeds its safe preparation limit.'
function M.new(api, nonce)
	if type(nonce) ~= 'string' or #nonce < 1 or #nonce > 64 or nonce:find('[^A-Za-z0-9_-]') then error('Invalid setup operation identifier.', 0) end
	local index, contents, total, command, failed = 1, {}, 0, nil, false
	local delimiter = 'TERN_UI_PAYLOAD_' .. nonce
	local object = {}
	function object.step()
		if failed then error(failure, 0) end
		if command then return command end
		if index <= #files then
			local file = files[index]
			local ok, value = pcall(api.fs.read, api.plugin.dir .. '/' .. file.source, 65536)
			if not ok or type(value) ~= 'string' or #value == 0 or #value > 65536 or value:find('%z') or value:sub(-1) ~= '\n' or value:find(delimiter, 1, true) then
				failed = true
				error(failure, 0)
			end
			total += #value
			if total > 110000 then failed = true; error(failure, 0) end
			contents[index], index = value, index + 1
			return nil
		end
		local lines = {
			'set -eu', 'umask 077', 'exec 2>/dev/null',
			'work=', 'complete=false',
			'finish() {',
			'  status=$?; trap - 0',
			'  [ -z "$work" ] || rm -rf "$work"',
			'  if [ "$complete" != true ]; then printf "TERN_OMP_SETUP_UI_V1 ERROR ' .. nonce .. '\\n"; exit 1; fi',
			'  exit "$status"', '}', 'trap finish 0', "trap 'exit 1' 1 2 15",
			'work=$(mktemp -d "${TMPDIR:-/tmp}/tern-setup-ui-payload.XXXXXXXX")',
			'mkdir "$work/package"',
		}
		for i, file in files do
			table.insert(lines, 'cat > "$work/' .. file.target .. '" <<' .. quote(delimiter))
			table.insert(lines, contents[i] .. delimiter)
		end
		table.insert(lines, 'status=0')
		table.insert(lines, 'sh "$work/install.sh" "$work/package" ' .. quote(nonce) .. ' || status=$?')
		table.insert(lines, 'complete=true')
		table.insert(lines, 'exit "$status"')
		local candidate = 'sh -c ' .. quote(table.concat(lines, '\n'))
		if #candidate > 131072 then failed = true; error(failure, 0) end
		command = candidate
		contents = {}
		return command
	end
	return object
end
return M
