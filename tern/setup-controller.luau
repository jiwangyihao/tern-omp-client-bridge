-- SPDX-License-Identifier: MPL-2.0
-- Window-side setup coordinator. Process callbacks are receipt-only; native UI runs in staged ticks.
local target = require('./setup-target')
local Discovery = require('./setup-ssh')
local M = {}
local function text(value, fallback)
	if type(value) ~= 'string' then return fallback or '' end
	local last = math.min(#value, 1024)
	while last > 0 and last < #value and string.byte(value, last + 1) >= 128 and string.byte(value, last + 1) < 192 do last -= 1 end
	local clipped = value:sub(1, last)
	if utf8.len(clipped) == nil then return fallback or '' end
	return (clipped:gsub('%c', ' '))
end
local function decode(value)
	if #value > 3072 or value:gsub('%%%x%x', ''):find('%%') then return nil end
	return (value:gsub('%%(%x%x)', function(c) return string.char(tonumber(c, 16)) end))
end

function M.new(api, options)
	local s = { phase = 'choose', stage = 'Choose host', message = 'Select the intended host and check SSH before installing.', revision = 1, run = 0, view = 0, hosts = {}, jobs = {}, attempts = {}, owner = options.owner }
	local controller = {}
	local armed = false
	local tick
	local viewJobs = { ['capture-host'] = true, ['caller-pane'] = true, hosts = true, ['local'] = true, ['local-capture'] = true, catalog = true, layout = true, create = true, ['ui-consent'] = true, ['ui-start'] = true, ['ui-build'] = true, ['ui-launch'] = true, ['ui-send'] = true, ['ui-begin'] = true, ['ui-chunk'] = true, ['view-pane'] = true, ['view-surface'] = true, ['view-encode'] = true, ['view-publish'] = true }
	local function queue(kind, value) table.insert(s.jobs, { kind = kind, value = value, view = viewJobs[kind] and s.view or nil }) end
	local function detach()
		local pane = s.pane
		if s.preparing and not s.pending then
			if s.bootstrapPane then queue('retire', s.bootstrapPane) end
			s.bootstrapPane, s.builder, s.nativeCommand, s.preparing = nil, nil, nil, nil
			if s.uiState then s.phase, s.stage, s.message = s.uiState.phase, s.uiState.stage, s.uiState.message; s.uiState = nil end
		end
		s.view += 1
		s.pane, s.panelId, s.uiTab, s.blockKind = nil, nil, nil, nil
		s.catalogDeadline, s.viewDeadline, s.heartbeat, s.viewQueued, s.payload = nil, nil, nil, nil, nil
		s.consentOpen, s.opening, s.suspended, s.viewNotice = false, false, true, nil
		local jobs = {}
		for _, job in s.jobs do if not job.view then table.insert(jobs, job) end end
		s.jobs = jobs
		return pane
	end
	local function notify()
		s.revision += 1
		s.dirty = true
		if options.onState then options.onState(s) end
		s.chromeDirty = true
	end
	local function viewFailure(message)
		s.opening, s.suspended, s.viewQueued = false, true, false
		s.viewNotice = message
		notify()
	end
	local function fail(message, interrupted)
		s.phase, s.stage, s.message, s.error = interrupted and 'interrupted' or 'failed', interrupted and 'Outcome needs checking' or 'Needs attention', message, message
		s.probe, s.auto, s.discovery, s.checkQueued = nil, nil, nil, false
		notify()
	end
	local function arm()
		if armed then return end
		armed = true
		api.timer(100, function(cx) armed = false; tick(cx) end)
	end
	local function currentMatches(cx)
		local session = cx.sessions:current()
		return session and s.uiSession and session.id == s.uiSession.id and session.host == s.uiSession.host
	end
	local function validSelection(cx)
		return s.selection and target.selectionValid(s.selection, cx.hosts:list())
	end
	local function mappings()
		local ok, value = pcall(api.kv.get, 'setup-hosts')
		if ok and value == nil then return { schema = 1, hosts = {} } end
		if not ok or type(value) ~= 'table' or value.schema ~= 1 or type(value.hosts) ~= 'table' then return nil end
		local count, result = 0, { schema = 1, hosts = {} }
		for address, destination in value.hosts do
			count += 1
			if count > 128 or type(address) ~= 'string' or #address > 1024 or address:find('%c') or not target.validHost(destination) then return nil end
			result.hosts[address] = destination
		end
		return result
	end
	local function remember()
		if not s.selection or s.selection.manual or not s.selection.address then return end
		local saved = mappings()
		if not saved then s.notice = 'The approved address could not be remembered; existing storage was preserved.'; return end
		local count = 0
		for _ in saved.hosts do count += 1 end
		if count >= 128 and not saved.hosts[s.selection.address] then s.notice = 'Address storage is full; installation uses the approved address without saving it.'; return end
		saved.hosts[s.selection.address] = s.ssh
		local ok = pcall(api.kv.set, 'setup-hosts', saved)
		if not ok then s.notice = 'Address storage failed; installation uses the approved address without saving it.' end
	end
	local function choose(selection, explicit)
		local saved = mappings()
		local ssh = not selection.manual and ((saved and selection.address and saved.hosts[selection.address]) or target.candidate(selection.address)) or nil
		local previous = s.selection
		if previous and previous.id == selection.id and previous.address == selection.address and previous.manual == selection.manual and (s.probe or s.completed) then return end
		if not table.isfrozen(selection) then table.freeze(selection) end
		s.selection, s.ssh = selection, ssh
		s.sshSource = selection.manual and 'manual' or (saved and selection.address and saved.hosts[selection.address] and 'saved' or 'address')
		s.probe, s.error, s.completed, s.approved, s.notice, s.nextConnection = nil, nil, nil, nil, nil, nil
		s.discovery, s.auto, s.candidates, s.attempts = nil, nil, nil, {}
		s.phase, s.stage, s.message = 'choose', 'Check SSH', 'Enter an SSH alias or find a profile for this host. Installation always requires approval.'
		if not selection.manual then s.checkQueued = true; queue('discover', explicit == true) end
		notify()
	end
	local function start(kind, argv, timeout)
		assert(not s.pending, 'Setup already has an active process')
		s.run += 1
		local run = s.run
		s.pending = { kind = kind, run = run, deadline = api.now() + timeout + 3000 }
		s.receipt = nil
		local ok = pcall(api.process.run, argv, { timeout_ms = timeout, env = { TERN_OMP_SETUP_DATA = api.plugin.data } }, function(result)
			-- No context, UI, filesystem, JSON, host enumeration, timers or refresh here.
			if s.pending and s.pending.run == run then s.receipt = result or { status = -1, stdout = '', stderr = 'ssh: not found', timed_out = false } end
		end)
		if not ok then s.receipt = { status = -1, stdout = '', stderr = 'ssh: not found', timed_out = false } end
		notify()
	end
	local function launchArgs()
		if api.runtime.os == 'windows' then
			local args = { 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', api.plugin.dir .. '/scripts/bootstrap.ps1', '-PluginRoot', api.plugin.dir, '-DataDir', api.plugin.data, '-HostAlias', s.approved.ssh }
			if s.approved.recover then table.insert(args, '-RecoverLock') end
			return args
		end
		local args = { '/bin/sh', api.plugin.dir .. '/scripts/bootstrap.sh', api.plugin.dir, api.plugin.data, s.approved.ssh }
		if s.approved.recover then table.insert(args, '--recover-lock') end
		return args
	end
	local function snapshot()
		local rows = {}
		for index, row in s.hosts do
			if index > 32 then break end
			table.insert(rows, { key = tostring(index), label = text(row.label), detail = text(row.detail), manual = row.manual == true })
		end
		local busy = s.pending ~= nil or s.launchQueued == true or s.checkQueued == true
		return {
			owner = s.owner, panelId = s.panelId, revision = s.revision, phase = s.phase,
			stage = s.stage, message = s.message .. (s.notice and (' ' .. s.notice) or '') .. (s.viewNotice and (' ' .. s.viewNotice) or ''), error = s.error and (s.error .. (s.notice and (' ' .. s.notice) or '')),
			hosts = rows, selectedLabel = s.selection and text(s.selection.name, 'Manual SSH target'), selectedAddress = s.selection and s.selection.address,
			ssh = s.ssh or '', platform = s.probe and (s.probe.system .. '/' .. s.probe.arch), busy = busy,
			targetKey = s.selection and (s.selection.manual and 'manual' or tostring(s.selection.id) .. ':' .. (s.selection.address or '')),
			sshSource = s.sshSource or 'manual', attempts = s.attempts,
			canDiscover = not busy and s.selection ~= nil and not s.selection.manual and not s.completed,
			canChoose = not busy, canCheck = not busy and s.selection ~= nil,
			canInstall = not busy and s.phase == 'review' and s.probe ~= nil,
			canRecover = not busy and s.phase == 'review' and s.probe ~= nil and s.recoveryRequired == true,
			canRetry = not busy and (s.phase == 'failed' or s.phase == 'interrupted'),
		}
	end
	local function fallback(message)
		local pane = detach()
		if pane then queue('retire', pane) end
		s.suspended, s.opening, s.needsUi = false, true, false
		if message then if s.probe or s.completed or s.pending then s.viewNotice = message; notify() else fail(message) end end
		queue('local')
	end
	local function consume(result, kind)
		if kind == 'discovery' then
			if s.discovery then s.discovery.accept(result); queue('discover-step') end
		elseif kind == 'probe' or kind == 'auto-probe' then
			local checked = target.preflightResult(result)
			local attempt = s.attempts[#s.attempts]
			if attempt then attempt.status, attempt.message = checked.ok and 'passed' or 'failed', checked.ok and 'SSH and platform checks passed.' or checked.message end
			if not checked.ok then
				if kind == 'auto-probe' and s.auto then queue('auto-probe'); notify()
				else fail(checked.message) end
				return
			end
			s.auto, s.checkQueued = nil, false
			s.probe = { ssh = s.ssh, system = checked.system, arch = checked.arch }
			s.phase, s.stage, s.error, s.message = 'review', 'Review installation', nil, 'SSH passed. Review this SSH destination against the selected Tern host; no installation has started.'
			queue('verify-target')
			notify()
		elseif kind == 'ui-native' then
			s.preparing, s.awaitNative = nil, nil
			if s.uiState then s.phase, s.stage, s.message = s.uiState.phase, s.uiState.stage, s.uiState.message; s.uiState = nil end
			queue('ui-cleanup')
			local expected = 'TERN_OMP_SETUP_UI_V1 READY ' .. s.nonce
			local output = type(result.stdout) == 'string' and #result.stdout <= 262144 and result.stdout or ''
			if result.status ~= 0 or (s.nativeCode ~= nil and s.nativeCode ~= 0) or not ('\n' .. output .. '\n'):find('\n' .. expected .. '\n', 1, true) then
				fallback('Remote interface preparation could not be verified. Continue in this local sidebar; existing Bridge files were not replaced.')
				return
			end
			s.needsUi = false
			if s.phase == 'checking' and not s.probe then s.phase, s.stage, s.message = 'choose', 'Check SSH', 'The native interface is ready. Select a host to check the separate Bridge SSH channel before installing runtime components.' end
			notify()
			if s.opening and not s.pane then s.catalogDeadline = api.now() + 12000; queue('catalog') end
		elseif kind == 'install' then
			local ok, value = false, nil
			if type(result.stdout) == 'string' and #result.stdout <= 65536 then ok, value = pcall(api.json.decode, result.stdout) end
			if result.status ~= 0 or result.timed_out or not ok or type(value) ~= 'table' or value.schema ~= 1 or value.kind ~= 'setup-complete' or value.host ~= s.ssh or type(value.stage) ~= 'string' or (value.status ~= 'ready' and value.status ~= 'awaiting_session') then
				local readOk, progress = pcall(function() return api.json.decode(api.fs.read(api.plugin.data .. '/setup-state.json', 65536)) end)
				s.recoveryRequired = readOk and type(progress) == 'table' and progress.stage == 'lock_recovery_required'
				fail(readOk and type(progress) == 'table' and progress.status == 'failed' and text(progress.message) or 'Initialization did not return a verified completion. Inspect the private setup log, then explicitly retry; existing sessions were not restarted.')
				return
			end
			s.completed = { phase = value.status, stage = text(value.stage), message = text(value.message) }
			s.phase, s.stage, s.message, s.error = s.completed.phase, s.completed.stage, s.completed.message, nil
			queue('connected')
			notify()
		end
	end
	local function execute(job, cx)
		if job.view and (job.view ~= s.view or (job.kind ~= 'local-capture' and not currentMatches(cx))) then
			s.suspended, s.viewQueued = true, false
			return
		end
		if job.kind == 'retire' then
			-- These are opaque handles obtained only from our own split; never reveal or inspect the old session.
			pcall(function() cx.layout:close(job.value) end)
		elseif job.kind == 'caller-pane' then
			local pane = s.edge and cx.session:pane(s.edge)
			if not pane or not pane.tab then s.opening = false; s.viewNotice = 'Open Bridge from a normal tab to show setup.'; notify(); return end
			s.uiTab = pane.tab
		elseif job.kind == 'capture-host' then
			s.originHost = cx.hosts:current()
			s.uiHost = s.originHost
			queue('hosts')
		elseif job.kind == 'hosts' then
			local hosts = cx.hosts:list()
			s.hosts = target.choices(hosts, s.originHost)
			if not s.selection then
				for _, row in s.hosts do if row.selection and s.originHost and row.selection.id == s.originHost.id then choose(row.selection); break end end
			end
			if not s.restored then s.restored = true; queue('restore') end
			if s.pane then notify() elseif s.opening then queue('catalog') end
		elseif job.kind == 'restore' then
			if not s.pending then
				local ok, value = pcall(function() return api.json.decode(api.fs.read(api.plugin.data .. '/setup-state.json', 65536)) end)
				if ok and type(value) == 'table' and value.schema == 1 then
					s.recoveryRequired = value.status == 'failed' and value.stage == 'lock_recovery_required'
					if value.status == 'installing' and value.host == s.ssh then fail('An earlier initialization reports that it was running. Its outcome is not verified; inspect the setup log before explicitly retrying. Ownership locks remain enforced.', true) end
				end
			end
		elseif job.kind == 'local' then
			cx.hosts:switch('local')
			queue('local-capture')
		elseif job.kind == 'local-capture' then
			s.uiSession = cx.sessions:current()
			s.edge = cx.session:focused()
			queue('caller-pane')
			queue('capture-host')
		elseif job.kind == 'catalog' then
			local kind
			for _, block in cx.session:block_types() do
				if block.kind == 'omp-client-bridge.setup' then kind = block.kind; break end
				if block.kind == 'omp-bridge-setup.panel' then kind = block.kind end
			end
			if kind then s.blockKind, s.catalogDeadline = kind, nil; queue('layout'); return end
			if s.catalogDeadline and api.now() < s.catalogDeadline then queue('catalog'); return end
			if s.uiHost.kind == 'local' then viewFailure('The local setup block is not loaded. Reload the local Bridge plugin and reopen setup.'); return end
			if s.catalogDeadline then s.catalogDeadline = nil; fallback('The remote interface was prepared but its block catalog did not become ready. Continue locally or reload the intended remote plugin.'); return end
			if s.pending then fallback(); return end
			s.needsUi = true
			queue('ui-consent')
		elseif job.kind == 'layout' then
			local layout = s.uiTab and cx.session:layout(s.uiTab)
			if not layout or layout.zoomed then viewFailure('Unzoom a normal tab on this host, then reopen the setup sidebar.'); return end
			local node = layout.root
			while node and node.split do node = node.split == 'right' and node[2] or node[1] end
			if not node or not node.pane then fail('No native right-edge pane is available for setup.'); return end
			s.edge = node.pane
			queue('create')
		elseif job.kind == 'create' then
			s.panelId = 'setup-' .. tostring(s.view)
			s.pane = cx.layout:split(s.edge, 'right', { block = s.blockKind, args = { s.owner, s.panelId } }, { focus = false })
			if not s.pane then viewFailure('Cannot open the native setup block. Reload the plugin on this host and retry.'); return end
			s.opening, s.suspended = false, false
			s.viewDeadline = api.now() + 10000
			notify()
		elseif job.kind == 'discover' then
			if not validSelection(cx) or s.selection.manual then s.checkQueued = false; fail('Select the intended connected Tern host before finding SSH profiles.'); return end
			local saved = mappings()
			s.discovery = Discovery.new(s.selection, saved, api.runtime.os)
			s.discoveryDeadline, s.searchDeadline = api.now() + 30000, api.now() + 90000
			s.probeAfterDiscovery = job.value == true
			s.probe, s.error, s.auto, s.attempts, s.candidates = nil, nil, nil, {}, nil
			s.phase, s.stage, s.message = 'checking', 'Finding SSH profiles', 'Resolving this device’s OpenSSH configuration; no SSH login or installation yet.'
			s.checkQueued = true
			queue('discover-step'); notify()
		elseif job.kind == 'discover-step' then
			if not s.discovery then return end
			if not validSelection(cx) then fail('Selected host changed during SSH profile discovery. Select it again.'); return end
			if api.now() >= s.discoveryDeadline then fail('SSH profile discovery reached its time limit. Enter the intended SSH alias manually.'); return end
			local operation = s.discovery.next()
			if not operation then
				local found = s.discovery.result()
				s.discovery, s.candidates, s.notice = nil, found.candidates, found.notice
				s.checkQueued = false
				if s.probeAfterDiscovery then
					s.auto = { index = 0, deadline = s.searchDeadline }; s.checkQueued = true; queue('auto-probe')
				else
					local first = s.candidates[1]
					if first then s.ssh, s.sshSource = first.destination, first.source end
					s.phase, s.stage, s.message = 'choose', 'Check SSH', first and 'A local SSH profile is suggested. Check SSH tries related candidates; editing the destination checks only your input.' or 'No related SSH profile was found. Enter the alias used in your terminal.'
				end
				notify()
			elseif operation.kind == 'read' then
				local ok, value = pcall(api.fs.read, operation.path, operation.limit)
				s.discovery.accept({ ok = ok, text = ok and value or nil }); queue('discover-step')
			else
				s.stage = text(operation.label, 'Resolving SSH profile')
				start('discovery', operation.argv, math.max(1, math.min(operation.timeout_ms, s.discoveryDeadline - api.now())))
			end
		elseif job.kind == 'auto-probe' then
			if not s.auto then return end
			if not validSelection(cx) then fail('Selected host changed during SSH checks. Select it again.'); return end
			local remaining = s.auto.deadline - api.now()
			s.auto.index += 1
			local candidate = s.candidates and s.candidates[s.auto.index]
			if not candidate or s.auto.index > 6 or remaining <= 0 then
				fail(remaining <= 0 and 'Related SSH checks reached their time limit. Edit the SSH destination and check it directly.' or 'No related SSH candidate passed. Review the results, then edit the SSH destination or find alternatives again.'); return
			end
			s.ssh, s.sshSource = candidate.destination, candidate.source
			s.phase, s.stage, s.message = 'checking', 'Checking SSH ' .. tostring(s.auto.index) .. '/' .. tostring(math.min(#s.candidates, 6)), 'Trying a related SSH profile with strict host-key checking; no remote writes.'
			table.insert(s.attempts, { ssh = s.ssh, source = s.sshSource, status = 'checking' })
			s.checkQueued = true
			start('auto-probe', target.preflightArgs(s.ssh), math.max(1, math.min(30000, remaining)))
		elseif job.kind == 'probe' then
			s.checkQueued = false
			if s.pending then return end
			if not validSelection(cx) then fail('Selected host changed or disconnected. Select it again; nothing was installed.'); return end
			if not target.validHost(s.ssh) then fail('Enter a valid SSH alias, user@host, or SSH URI.'); return end
			s.attempts = { { ssh = s.ssh, source = 'manual', status = 'checking' } }
			s.phase, s.stage, s.message, s.error, s.probe = 'checking', 'Checking SSH', 'Checking authentication, host trust, platform and basic tools; no remote writes.', nil, nil
			start('probe', target.preflightArgs(s.ssh), 30000)
		elseif job.kind == 'verify-target' then
			if not validSelection(cx) then fail('Selected host changed or disconnected. Check the intended target again.'); end
		elseif job.kind == 'ui-consent' then
			if not validSelection(cx) then fail('Selected host changed before interface preparation.'); return end
			s.consentOpen = true
			local view = s.view
			cx:pick({ placeholder = 'Prepare setup sidebar on ' .. text(s.uiHost.name, 'this connected host') .. '?', icon = 'shield', action = 'choose', items = {
				{ label = 'Install interface through the existing Tern connection', detail = 'Prepare the small native UI package. No new SSH connection, Bun, SDK, broker/client or OMP restart. A temporary preparation pane will close after success.', decision = 'remote' },
				{ label = 'Use the local setup sidebar', detail = 'Switch to this device; retain the selected remote target.', decision = 'local' },
				{ label = 'Cancel', decision = 'cancel' },
			} }):next(function(choice, _, fresh)
				if view ~= s.view then return end
				s.consentOpen = false
				if not choice or not fresh or not currentMatches(fresh) then s.opening = false; return end
				if choice.decision == 'remote' then queue('ui-start') elseif choice.decision == 'local' then queue('local') else s.selection, s.ssh, s.probe, s.opening = nil, nil, nil, false end
				arm()
			end)
		elseif job.kind == 'ui-start' then
			if not currentMatches(cx) or not validSelection(cx) then fail('Selected host changed before UI deployment.'); return end
			s.uiState = { phase = s.phase, stage = s.stage, message = s.message }
			s.preparing, s.bootstrapSession = true, s.uiSession
			s.phase, s.stage, s.message = 'checking', 'Preparing remote sidebar', 'Preparing only the native interface through the already-connected Tern host; no SSH or runtime installation.'
			s.run += 1
			s.nonce = 'ui_' .. tostring(s.run) .. '_' .. tostring(math.floor(api.now()))
			local Bootstrap = options.bootstrap or require('./setup-bootstrap')
			s.builder = Bootstrap.new(api, s.nonce)
			queue('ui-build')
			notify()
		elseif job.kind == 'ui-build' then
			local command = s.builder.step()
			if command then s.nativeCommand = command; s.builder = nil; queue('ui-launch') else queue('ui-build') end
		elseif job.kind == 'ui-launch' then
			if not currentMatches(cx) or not validSelection(cx) then fail('Connected host changed before native UI preparation.'); return end
			s.bootstrapPane = cx.layout:split(s.edge, 'right', {}, { focus = false })
			if not s.bootstrapPane then fail('Could not open an owned preparation pane on this connected host.'); return end
			s.nativeCode = nil
			s.shellDeadline = api.now() + 15000
			queue('ui-send')
		elseif job.kind == 'ui-send' then
			-- The view-generation guard already pins this call to the approved native host/session.
			local pane = cx.session:pane(s.bootstrapPane)
			if not pane or pane.kind ~= 'terminal' then fail('The owned preparation terminal is no longer available.'); return end
			if not pane.at_prompt then
				if api.now() >= s.shellDeadline then fail('The preparation terminal did not reach a shell prompt.'); return end
				queue('ui-send'); return
			end
			queue('ui-begin')
		elseif job.kind == 'ui-begin' then
			cx:run(s.bootstrapPane, '\27[200~')
			s.nativeOffset = 1
			queue('ui-chunk')
		elseif job.kind == 'ui-chunk' then
			local last = math.min(#s.nativeCommand, s.nativeOffset + 511)
			while last < #s.nativeCommand and string.byte(s.nativeCommand, last + 1) >= 128 and string.byte(s.nativeCommand, last + 1) < 192 do last -= 1 end
			local chunk = s.nativeCommand:sub(s.nativeOffset, last)
			if #chunk > 0 then
				cx:run(s.bootstrapPane, chunk)
				s.nativeOffset += #chunk
				queue('ui-chunk')
			else
				cx:run(s.bootstrapPane, '\27[201~\r')
				s.nativeCommand = nil
				s.pending = { kind = 'ui-native', run = s.run, deadline = api.now() + 123000 }
				queue('ui-await')
			end
		elseif job.kind == 'ui-await' then
			if not s.pending or s.pending.kind ~= 'ui-native' then return end
			local session = cx.sessions:current()
			if not s.bootstrapSession or session.id ~= s.bootstrapSession.id or session.host ~= s.bootstrapSession.host then s.awaitNative = true; return end
			s.awaitNative = nil
			local run = s.pending.run
			cx.session:settle(s.bootstrapPane, 120000):next(function(output, err)
				if s.pending and s.pending.run == run then s.receipt = { status = err and 1 or 0, stdout = output or '', stderr = '', timed_out = false } end
			end)
			notify()
		elseif job.kind == 'ui-cleanup' then
			local pane = s.bootstrapPane
			s.bootstrapPane = nil
			if pane then pcall(function() cx.layout:close(pane) end) end
		elseif job.kind == 'install' then
			local approved = s.approved
			if not approved or not target.selectionValid(approved.selection, cx.hosts:list()) or not s.probe or s.probe.ssh ~= approved.ssh then s.launchQueued = false; fail('The approved target is no longer valid. Check SSH again before installing.'); return end
			queue('install-remember')
		elseif job.kind == 'install-remember' then
			remember()
			queue('install-start')
		elseif job.kind == 'install-start' then
			s.launchQueued = false
			if not s.approved or not target.selectionValid(s.approved.selection, cx.hosts:list()) or s.ssh ~= s.approved.ssh then fail('The approved target changed before launch. Check SSH again before installing.'); return end
			s.phase, s.stage, s.message, s.error = 'installing', 'Starting', 'Installing the explicitly approved local and remote components.', nil
			start('install', launchArgs(), 900000)
		elseif job.kind == 'connected' then
			if not s.completed then s.nextConnection = nil; return end
			local status, message = 'ready', nil
			if options.onConnected then
				local ok
				ok, status, message = pcall(options.onConnected)
				if not ok then status, message = 'error', 'Bridge readiness could not be read. Reopen Bridge to retry without reinstalling.' end
			end
			local phase, stage, detail = s.completed.phase, s.completed.stage, s.completed.message
			if status ~= 'ready' then
				phase, stage = 'awaiting_session', 'awaiting-local-endpoint'
				detail = 'Installation verified; waiting for this device’s Bridge endpoint metadata. Reopen Bridge to retry; do not reinstall or restart OMP.'
				if message then detail ..= ' ' .. text(message) end
				s.nextConnection = api.now() + 1500
			else s.nextConnection = nil end
			if s.phase ~= phase or s.stage ~= stage or s.message ~= detail then s.phase, s.stage, s.message, s.error = phase, stage, detail, nil; notify() end
		elseif job.kind == 'select' then
			local row = s.hosts[tonumber(job.value)]
			if not row then return end
			choose(row.manual and { manual = true, name = 'Manual SSH target' } or row.selection, true)
		elseif job.kind == 'view-pane' then
			local pane = s.pane and cx.session:pane(s.pane)
			if not pane or pane.kind ~= 'plugin' or pane.block ~= s.blockKind then detach(); return end
			queue('view-surface')
		elseif job.kind == 'view-surface' then
			local surface = cx.session:surface(s.pane, { depth = 0, nodes = 1 })
			if not surface or not surface.surface or surface.surface.role ~= 'plugin.' .. s.blockKind then
				s.viewQueued = false
				if s.viewDeadline and api.now() > s.viewDeadline then s.viewDeadline = nil; s.suspended = true; s.viewNotice = 'The native setup view did not become ready. Reopen Bridge to recreate the view; the operation and approved target are retained.'; notify() end
				return
			end
			s.viewDeadline = nil
			queue('view-encode')
		elseif job.kind == 'view-encode' then
			s.payload, s.payloadRevision = api.json.encode(snapshot()), s.revision
			if #s.payload > 65536 then s.viewQueued, s.suspended = false, true; s.viewNotice = 'Setup display exceeded its safe size.'; notify(); return end
			queue('view-publish')
		elseif job.kind == 'view-publish' then
			cx.session:event(s.pane, { ev = 'action', act = 'setup-snapshot', value = s.payload })
			s.dirty, s.heartbeat, s.viewQueued = s.payloadRevision ~= s.revision, api.now() + 5000, false
			s.payload = nil
		end
	end
	tick = function(cx)
		if not cx then return end
		local activeJob
		local ok = pcall(function()
			if s.receipt and s.pending then
				local result, kind = s.receipt, s.pending.kind
				s.receipt, s.pending = nil, nil
				consume(result, kind)
			elseif s.pending and api.now() > s.pending.deadline then
				s.run += 1
				local kind = s.pending.kind
				s.pending, s.receipt = nil, nil
				if kind == 'discovery' or kind == 'probe' or kind == 'auto-probe' then
					consume({ status = -1, stdout = '', stderr = '', timed_out = true }, kind)
				else
					s.awaitNative, s.preparing, s.uiState = nil, nil, nil
					fail('No completion callback arrived before the deadline. Outcome is unknown; inspect the private setup log before retrying. Nothing will advance automatically.', true)
				end
			elseif #s.jobs > 0 then activeJob = table.remove(s.jobs, 1); execute(activeJob, cx)
			elseif s.chromeDirty then
				s.chromeDirty = false
				if options.refresh then options.refresh() end
			elseif s.pane and not s.suspended and not s.viewQueued and (s.dirty or api.now() >= (s.heartbeat or 0)) then
				if not currentMatches(cx) then s.suspended = true; s.viewDeadline = nil; return end
				s.viewQueued = true
				queue('view-pane')
			elseif s.nextConnection and api.now() >= s.nextConnection then
				queue('connected')
			elseif s.awaitNative and s.pending then
				local session = cx.sessions:current()
				if s.bootstrapSession and session.id == s.bootstrapSession.id and session.host == s.bootstrapSession.host then queue('ui-await') end
			elseif s.pending and s.pending.kind == 'install' and api.now() >= (s.nextProgress or 0) then
				s.nextProgress = api.now() + 1500
				local readOk, progress = pcall(function() return api.json.decode(api.fs.read(api.plugin.data .. '/setup-state.json', 65536)) end)
				if readOk and type(progress) == 'table' and progress.schema == 1 and progress.status == 'installing' and (not progress.host or progress.host == s.ssh) then
					local stage, message = text(progress.stage), text(progress.message)
					if stage ~= s.stage or message ~= s.message then s.stage, s.message = stage, message; notify() end
				end
			end
		end)
		if not ok then
			-- A view failure must not erase an active receipt or turn verified installation into failure.
			local jobs = {}
			for _, job in s.jobs do if not job.view then table.insert(jobs, job) end end
			s.jobs, s.suspended, s.viewQueued, s.opening = jobs, true, false, false
			s.viewNotice = 'A setup view operation failed. Reopen Bridge to recreate the view; the approved target and active operation are retained.'
			notify()
			if activeJob and not activeJob.view and activeJob.kind ~= 'retire' and activeJob.kind ~= 'connected' and not s.pending then
				s.launchQueued, s.checkQueued = false, false
				fail('The setup operation could not advance. Inspect the setup log and explicitly check the intended target again; no operation will restart automatically.', true)
			end
		end
		if (s.pane and not s.suspended) or s.pending or #s.jobs > 0 or s.chromeDirty or s.nextConnection then arm() end
	end
	function controller.open(cx)
		if api.runtime.os ~= 'macos' and api.runtime.os ~= 'linux' and api.runtime.os ~= 'windows' then cx:toast('error', 'Bridge setup', 'Initialize from a desktop client with SSH support.'); return end
		-- Capture the caller before touching any owned pane; focus is never an identity source.
		local session, edge = cx.sessions:current(), cx.session:focused()
		if not session then return end
		if not s.pane and (s.consentOpen or s.preparing) and s.uiSession and session.id == s.uiSession.id and session.host == s.uiSession.host and not s.suspended then arm(); return end
		local pane = detach()
		s.uiSession, s.edge = { id = session.id, host = session.host }, edge
		s.opening, s.suspended = true, false
		queue('caller-pane')
		if pane then queue('retire', pane) end
		queue('capture-host')
		if s.completed then queue('connected') end
		notify()
		arm()
	end
	function controller.hide(_cx)
		local pane = detach()
		if pane then queue('retire', pane) end
		notify()
		arm()
	end
	function controller.route(req, cx)
		if type(req.url) ~= 'string' or req.url:sub(1, 19) ~= 'omp-bridge-setup://' then return nil end
		if #req.url > 4096 then return { handled = true } end
		local owner, panelId, revision, verb, value = req.url:match('^omp%-bridge%-setup://([%w_.%-]+)/([%w_.%-]+)/(%d+)/([a-z]+)(.*)$')
		if owner ~= s.owner or panelId ~= s.panelId or req.pane ~= s.pane or not currentMatches(cx) then return { handled = true } end
		if verb == 'hide' then local pane = detach(); if pane then pcall(function() cx.layout:close(pane) end) end; notify(); arm(); return { handled = true } end
		if tonumber(revision) ~= s.revision then return { handled = true } end
		if value ~= '' then if value:sub(1, 1) ~= '/' then return { handled = true } end; value = decode(value:sub(2)); if not value then return { handled = true } end end
		if s.pending or s.launchQueued or s.checkQueued or #s.jobs > 0 then return { handled = true } end
		if verb == 'select' then queue('select', value)
		elseif verb == 'discover' then
			if s.completed or not s.selection or s.selection.manual then return { handled = true } end
			s.checkQueued = true; queue('discover', true)
		elseif verb == 'checkprofiles' then
			if s.completed then return { handled = true } end
			if value ~= s.ssh or s.sshSource == 'manual' or not s.candidates or #s.candidates == 0 then
				fail('The suggested SSH profiles changed. Find alternatives again or check a manual destination.')
			else
				s.auto, s.attempts, s.checkQueued = { index = 0, deadline = api.now() + 90000 }, {}, true; queue('auto-probe')
			end
		elseif verb == 'check' then
			local destination = target.candidate(value)
			if not destination then fail('Enter one SSH alias, user@host or SSH URI, not a shell command.')
			elseif s.completed or (s.probe and s.probe.ssh == destination) then return { handled = true }
			else
				s.notice = nil
				s.ssh, s.sshSource, s.probe, s.auto, s.candidates, s.checkQueued = destination, 'manual', nil, nil, nil, true
				queue('probe')
			end
		elseif verb == 'install' or verb == 'recover' then
			if s.phase ~= 'review' or not s.probe or value ~= s.ssh or (verb == 'recover' and not s.recoveryRequired) then return { handled = true } end
			s.recover, s.launchQueued = verb == 'recover', true
			s.approved = table.freeze({ selection = s.selection, ssh = s.ssh, recover = s.recover })
			queue('install')
		elseif verb == 'retry' then
			if s.phase ~= 'failed' and s.phase ~= 'interrupted' then return { handled = true } end
			if s.sshSource == 'manual' then s.probe, s.checkQueued = nil, true; queue('probe')
			else s.checkQueued = true; queue('discover', true) end
		elseif verb == 'refresh' then queue('hosts'); if s.completed then queue('connected') end end
		arm()
		return { handled = true }
	end
	function controller.closed(pane) if pane and pane == s.pane then detach(); notify(); arm() end end
	function controller.commandFinished(ev)
		if ev.pane == s.bootstrapPane then s.nativeCode = ev.status end
	end
	function controller.status() return s end
	return controller
end
return M
