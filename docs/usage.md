# Setup and usage

## Prerequisites and roles

The **agent host** runs OMP, the bridge broker, and an SSH server. Each **client
device** runs Tern and its own outbound bridge client in the interactive user's
session. Tern's existing remote connection is not the bridge's executor channel;
the companion client starts its own SSH process.

Required on both machines:

- Bun **1.4.3 or newer** and a retained copy of this package with dependencies
  installed from `bun.lock`. The native SDK dependencies are pinned to **18.10.4**.
  Node alone is not the service runtime.
- Filesystem permission to create private bridge state. On Windows, the private
  ACL implementation requires `powershell.exe`.

Additionally:

- The agent host needs a native OMP installation exposing the extension lifecycle,
  native same-name tool delegation, scoped Settings, and interactive editor hooks
  used by SDK 18.10.4. Load through OMP's native extension loader, not an ad hoc
  imported extension object.
- The client needs Tern's native plugin APIs used by `tern/window.luau` and OpenSSH
  `ssh` on `PATH`. Establish and verify the SSH host key yourself first. Configure
  noninteractive authentication: the bridge uses `BatchMode=yes`, disables agent
  forwarding, and does not prompt for passwords or host-key acceptance.
- Python Eval needs a locally installed interpreter supported by the SDK; automatic
  provisioning is disabled. Browser/desktop/ADB have additional prerequisites in
  [Compatibility](compatibility.md). No model credentials are needed by the
  execution-only companion.

Tern's native GUI must be normally signed in. A separate test configuration does
not inherit another profile's login or first-run setup; complete those steps in
that profile without copying credentials. Desktop input and GUI acceptance also
require an unlocked interactive session. The bridge does not bypass account,
extension-trust, screen-lock, or OS-permission gates.

Use a trusted SSH configuration alias, such as `bridge-agent`, for the intended
agent host/account. This alias is an example, not a bundled SSH configuration.
Ensure a normal SSH connection works before starting the bridge.

## Install from source on both machines

Run these commands in your chosen installation parent directory on each machine,
then keep the checkout in place:

```sh
git clone https://github.com/jiwangyihao/tern-omp-client-bridge.git
cd tern-omp-client-bridge
bun install --frozen-lockfile --ignore-scripts
bun src/cli.ts --help
```

These commands also work in a native Windows PowerShell terminal with Git and Bun
on `PATH`. Do not substitute a WSL checkout for the Windows client. All commands
below using `bun src/cli.ts` run from this checkout, unless an absolute path is
shown. A published global package is not assumed.

### 1. Agent host: install OMP integration and start the broker

```sh
bun src/cli.ts install-omp
bun src/cli.ts server
```

`install-omp` writes only
`extensions/tern-omp-client-bridge/index.ts` beneath the native SDK's agent
directory (`getAgentDir()`). Its output reports the actual loader and entrypoint.
It does not edit global settings. To select a different native agent directory,
pass `--target` with that directory; make sure OMP actually uses the same directory.
The loader imports this checkout by file URL, including on Windows. Moving or
removing the checkout breaks it; rerun the installer after relocating.

Keep `server` running in its terminal. It prints a `broker-ready` record with a
loopback URL and writes private endpoint metadata. An omitted port selects an
ephemeral port; `--port` accepts integers from 1 through 65535. No public listener
or inbound laptop connectivity is needed. Restart OMP yourself after installing
its extension, and open it through Tern's normal remote workflow.

### 2. Client device: install the Tern plugin

```sh
bun src/cli.ts install-tern
```

This copies `tern/plugin.toml`, `window.luau`, and `bridge.css` into the native Tern
plugin directory and merges only `controlFile` into this plugin's configuration.
It preserves other plugins and unrelated settings. Reload Tern plugins or restart
Tern yourself. No application reload or background service starts automatically.

Default Tern locations:

| Platform | Plugin configuration root | Plugin data root |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Tern` | Same root |
| Windows | `%APPDATA%\Tern` | `%LOCALAPPDATA%\Tern` |
| Other platforms | `$XDG_CONFIG_HOME/tern`, otherwise `~/.config/tern` | `$XDG_STATE_HOME/tern`, otherwise `~/.local/state/tern` |

The installed plugin is `plugins/omp-client-bridge`; its configuration is
`plugin-data/omp-client-bridge/config.json`. `install-tern --target PATH` places
**both** roots beneath `PATH`; `TERN_CONFIG_DIR` has the same root-selection effect
when `--target` is omitted. This does not tell a running Tern to use that directory:
its own configuration must match. Conflicting unrelated files, links, or manifests
are rejected rather than overwritten.

### 3. Client device: start the outbound executor

The default relay command is `tern-omp-bridge relay`. It works only if that package
binary and the required Bun runtime are available in the remote noninteractive
SSH environment. For a source checkout, explicitly supply the remote command.

For example, **if** the agent-host checkout is `/srv/tern-omp-client-bridge` and
`bun` is on the remote noninteractive `PATH`, run on the client:

```sh
bun src/cli.ts client --host bridge-agent --name Workstation --allow files,exec --remote-command 'bun /srv/tern-omp-client-bridge/src/cli.ts relay'
```

Replace the alias and remote installation path with your configured values.
Use an absolute Bun executable path in `--remote-command` if SSH does not inherit
its installation directory in `PATH`. The string is interpreted by the **remote
SSH account's shell**; quote paths with spaces for that shell, not the client's
shell. It must execute only the relay protocol on stdout: shell startup banners
or extra output corrupt that stream. You do not manually run `relay` in a terminal.

A native Windows client can start the same outbound connection in PowerShell:

```powershell
bun src/cli.ts client --host bridge-agent --name WindowsWorkstation --allow files,exec --cwd 'C:\Projects\Example' --remote-command 'bun /srv/tern-omp-client-bridge/src/cli.ts relay'
```

The client working directory must already exist. If `--cwd` is omitted, native
execution starts in the client user's home directory, not the agent-host project.
Choose a non-sensitive `--name`; otherwise first-time identity creation uses the
machine hostname as its display name.

`client-ready` means the local UI endpoint is ready, **not** that SSH registration
has succeeded. Check Tern's connection/device status before invoking client tools.
Each client needs its own identity/state directory; do not copy `identity.json`
between machines.

### Capability grants

`--allow` is required on **every** client start. It is either `none` or a
comma-separated, nonduplicated selection of `files,exec,computer,browser,adb`.
Restart the client with a new list to change the grant.

| Grant | Bridge behavior |
| --- | --- |
| `none` | Human transfers and device UI only; no agent file/execution tools |
| `files` | Existing `read`, `write`, `edit`, `grep`, and `glob` on the client |
| `exec` | Native Bash and JS/Python Eval |
| `computer` | Adds native computer prelude to enabled Eval; also grant `exec` |
| `browser` | Adds native browser prelude to enabled Eval; also grant `exec` |
| `adb` | Advertises the device capability; use installed ADB through granted `exec`, not a separate bridge tool |

These are coarse grants, not OS isolation. In particular, `exec` can run arbitrary
code using the account's filesystem, browser processes, or ADB executable even
without the corresponding convenience capability. See [Security](security.md).

## State directory selection

`TERN_OMP_BRIDGE_HOME` overrides the bridge state root. Otherwise:

| Platform | Default state root |
| --- | --- |
| macOS | `~/Library/Application Support/tern-omp-client-bridge` |
| Windows | `%LOCALAPPDATA%\tern-omp-client-bridge`, falling back to the user home as parent |
| Other platforms | `$XDG_STATE_HOME/tern-omp-client-bridge`, otherwise `~/.local/state/tern-omp-client-bridge` |

`server`, `relay`, and `client` accept `--state-dir PATH`. A custom **agent-host**
root must match in three places: `server --state-dir`, the remote `relay
--state-dir`, and `TERN_OMP_BRIDGE_HOME` in the process launching OMP. The extension
has no CLI `--state-dir` flag of its own. Setting the environment only on your
client does not configure the remote host.

For a custom **client** root, match `client --state-dir PATH` with
`install-tern --control-file PATH/client.json`, or set `TERN_OMP_BRIDGE_HOME` for
both commands. On Windows, a concrete form is:

```powershell
bun src/cli.ts install-tern --control-file 'C:\BridgeState\client.json'
bun src/cli.ts client --host bridge-agent --allow none --state-dir 'C:\BridgeState' --remote-command 'bun /srv/tern-omp-client-bridge/src/cli.ts relay'
```

The control file is **`client.json`**, never `identity.json`. Do not paste either
file into an issue or chat. Run one client service per chosen client state root.

## Choose the shared execution target

Focus the live remote OMP conversation in Tern and use **OMP: Select agent client**
or the bridge's device status segment. The plugin resolves the actual OMP
conversation before changing its binding. New sessions are **Unbound**. Choose
an authorized device explicitly; **This device** identifies the current viewer,
not necessarily the agent target.

The selection belongs to the OMP session, not its pane, SSH username, or latest
viewer. All viewers see ordered changes with the actor and old/new targets. A
stale picker selection is rejected; reopen the picker to use current state.
Focus changes and reconnects do not auto-select. An offline selected device stays
selected and fails client operations rather than falling back to the agent host.

A switch takes effect at the next invocation boundary. A running Eval cell,
including later helper statements, keeps its original device. Background results
and process handles retain that owner. Switching back reuses still-live device
state; it does not copy kernels, cookies, shells, or handles between devices.

## Existing tools, not a second tool family

The extension adds `target: "agent" | "client"` only to existing `eval` and `bash`.
Omitting it keeps native agent-host behavior. For example, these are model-tool
argument objects, not shell commands:

```json
{"target":"client","language":"js","code":"console.log(process.platform, process.cwd())"}
```

```json
{"target":"client","command":"pwd"}
```

Keep the native tool's other required arguments and supported options. The
extension retains the installed host's schemas and strips its routing field
before native execution. Client Eval has separate persistent JS/Python contexts;
`reset` applies to the selected language/device/context. Subagents use the parent
conversation's binding but separate execution contexts. Client Eval does not
provide model completion, judgment, image questions, or reasoning-agent spawning.
Nested native helpers stay in the client context; unsupported helpers fail.

**Ordinary Bash uses native embedded brush/POSIX syntax on Windows too.** It is
neither WSL nor an implicit `cmd.exe`/PowerShell session. Run an explicitly chosen
native executable if its syntax is required. Named PTY services use the native
service shell reported by the runtime; unnamed `pty:true` is rejected because the
companion has no OMP TUI overlay. Automatic Bash backgrounding is disabled to
retain ordinary shell state; explicit `async` remains available. Use returned
`proc://` handles for owned service input/output/termination and preserve their
complete provenance. See the native tool documentation for command options.

### Client filesystem paths

Use absolute real paths with an empty URI authority:

- macOS: `client:///Users/example/project/file.ts`
- Windows: `client:///C:/Projects/Example/file.ts`
- Windows UNC: `client:////server/share/file.txt` (a filesystem share, not a bridge
  device selector).

Use forward slashes in these URIs. Percent-encode filename characters such as
spaces (`%20`), `#` (`%23`), and `?` (`%3F`) when needed; native query/selector syntax
remains separate. `client://device/path`, relative paths, backslashes, and malformed
client addresses are rejected, not treated as agent-host paths. There are no
project/download aliases or URI-selected client IDs.

Existing `read`, `write`, `edit`, `grep`, and `glob` route explicit client paths.
Ordinary paths and other native schemes retain their normal routing. Do not mix
agent-host and client paths in one filesystem operation. Copy returned snapshot
headers **verbatim**, including device/context provenance, query, and hash, when
editing. A snapshot from one device cannot authorize an edit to another device's
same-named file; reread after switching or after a version conflict. Returned
bridge-owned artifact/process handles likewise keep their original owner.
Images read as tool results and browser/computer screenshots remain supported
through the native runtime, subject to backend availability.

## Human files and the unsent draft

On this device, focus the intended remote OMP composer. The plugin routes eligible
local file drops; their source is this viewer, independently of the agent binding.
Plain text uses Tern's original native paste implementation untouched. The bridge
does not override Paste, read/classify the clipboard, delay text for destination
validation, or replay a native command. Path-shaped text does not instruct the
bridge to upload a file. The local capture endpoint accepts only explicit selected
file paths; clipboard requests are rejected. No replacement chord, clipboard
watcher, or agent clipboard tool is added.

Ordinary files are privately snapshotted, streamed in bounded chunks, verified
with SHA-256, and published to real agent-host files. After checking the original
conversation/draft and file sizes, the extension reads the latest editor text
and synchronously appends quoted file paths to the core editor. It neither sends
a prompt nor simulates Enter. A changed/closed/submitted draft fails rather than
receiving an attachment in the newly focused pane.

Snapshot copying observes cancellation of its capture request. An abandoned
request removes its private snapshot, including a completed snapshot not yet
claimed for upload. Claiming a capture transfers cancellation ownership to the
upload; a later cancellation of the capture request cannot remove an upload's
files. Original files and other captures remain untouched.

Already-captured drops targeting one view share an in-flight destination
handshake, while each retains its own original conversation/draft checks. One
such validation does not supersede another file's validation.
Receipt freshness is required when admitting an upload. After admission, a new
handshake for the same conversation/draft does not cancel it, including while
upload initialization is pending. The original connection and destination remain
pinned; replacement conversations/drafts still reject and clean up the upload.

Published basenames include their unique index prefix within a 255-byte UTF-8
limit. Truncation preserves complete characters; transfer metadata retains the
original filename.

**Bridge-managed image-file attachment is rejected.** The bridge rejects recognized
image files before its own upload/editor mutation, including mixed selections.
It does not inspect clipboard bitmaps. Native file/image paste routes remain outside
this control, so the approved pure-plugin fail-closed requirement is still blocked.
Same-Mac loopback file-paste observations are not actual remote-server upload
acceptance. Do not rename images to bypass detection. A successful ordinary-file
transfer is a file reference, not an image preview or hidden image queue.
Screenshots returned by tools are unaffected.

Use **OMP: Human transfer progress / cancel** to inspect phases, byte counts, and
errors or cancel an unfinished transfer. At most 256 regular files are accepted
per capture; directories and special files are rejected. Completion of an upload
alone is not proof that the editor accepted it. Inspect the draft if the final
receipt is lost; do not blindly repeat a possibly completed transfer. Attached
references cannot be cancelled as partial uploads.

Restoring native text does not complete native file/bitmap Cmd/Ctrl+V or fail-closed
image rejection: safe native hooks for those routes remain missing. Native text
under IME/streaming and Windows/macOS GUI drop targeting still require GUI evidence.
Tern's drop request lacks an explicit hovered-pane field: the implementation uses
the focused remote pane. Focus the intended composer first and do not assume
cross-pane drops are proven safe. See [Compatibility](compatibility.md).

## Approvals and backend use

On the executing device, keep Tern connected and use **OMP: Pending client
approvals** when the status indicates a pending interaction. Review its actual
operation and choose a displayed option or Reject. No recent local UI, timeout,
cancel, disconnect, or missing approval support means denial. Remote `approved`
flags cannot grant local control. OMP's provider-facing safety handling remains
on the agent host; the device approval is an additional native boundary.

Browser and computer helpers are the existing Eval preludes. Browser execution
uses the client-owned native backend, not the agent host's browser or Tern's
embedded session. Desktop control needs the interactive desktop, native helper,
OS permissions, and human confirmation. ADB runs through existing execution with
an explicit serial, for example `adb -s SERIAL shell ...`; replace `SERIAL` with a
device that is actually attached and authorized. The bridge does not authorize
Android devices or expose an unprotected ADB server.

### ADB workflow

Run ADB through client-targeted Bash/Eval, not on the agent host. Start with
`adb version` and `adb devices -l`; an empty list is a missing device prerequisite,
and `unauthorized` requires confirmation on the Android device itself.

- Select one authorized serial explicitly: `adb -s SERIAL shell getprop ro.product.model`.
- Read only the authorized log scope, for example `adb -s SERIAL logcat -d -t 100`.
  Device logs can contain private application data; do not publish them unredacted.
- Use `adb -s SERIAL push CLIENT_FILE DEVICE_FILE` and
  `adb -s SERIAL pull DEVICE_FILE CLIENT_FILE` for file transfer. Client paths belong
  to the selected client, not the agent host. Use unique owned fixture paths; do
  not overwrite or delete unrelated device files.
- For screenshots, use client Eval to capture binary stdout from
  `adb -s SERIAL exec-out screencap -p` into a uniquely named client file, check the
  process exit status, then read that file through its `client://` path. Do not
  decode PNG stdout as terminal text. Capture only an explicitly authorized screen.

Executable discovery is not device acceptance. Logs, screenshots, and transfers
must be verified against an actual authorized Android device.


## Shutdown, reconnect, and recovery

Stop foreground `server`/`client` with Ctrl+C. Services also close on stdin EOF or
SIGTERM; redirecting stdin from an already closed stream is not a daemonization
method. There is no installed service manager. Wait for shutdown before starting
another broker in the same state root.

A dropped transport reconnects and authenticates again, but operations, uploads,
and uncertain attachment sends are not replayed. Inspect the original device or
remote draft before explicitly retrying a side effect. Cancellation is not a
rollback: commands or clicks may already have had effects. Offline background
notifications are not durably queued.

An ordinary reconnect to the same broker can retain live client contexts. A
broker restart has a new instance identity: old execution contexts and draft
receipts are invalidated, and in-memory bindings must be selected again. Restarting
the client is not a restoration of its old Eval kernels. Closing an OMP session
requests disposal of that session's owned client contexts.

| Symptom | Action |
| --- | --- |
| `UNSUPPORTED_RUNTIME` | Use Bun >=1.4.3 for bridge services; do not replace the OMP installation as a workaround. |
| `BROKER_LOCKED` | Inspect `server.lock` and its process. Remove only a confirmed stale lock after its owner has exited; never remove it to start a second live broker. |
| Local UI unavailable | Check the running client and the plugin's `controlFile`; restart/reload Tern only after configuration is correct. |
| Client ready but offline | Check SSH alias/authentication, trusted host key, remote Bun/package paths, broker availability, and matching remote state directory. |
| Handshake timeout | Confirm the focused program is remote OMP, its native extension loaded, and OMP sees the broker's state directory. |
| `host_sdk_mismatch` / session policy unavailable | Load through the native OMP extension lifecycle with compatible SDK resolution; do not bypass safety by replacing scoped settings. |
| Image attachment unsupported | Expected scope restriction; ordinary-file references and tool image results are the supported paths. |
| Outcome unknown | Inspect effects on the original device/draft; there is no automatic replay or failover. |
| Cleanup failure | Preserve retained state for diagnosis and inspect owned processes before deleting anything. |

### Retention and removal

- `identity.json` persists the device key and label across starts. Protect it;
  removing it creates a different identity next time rather than revoking an
  already running process.
- `server.json`/`client.json` hold private endpoint credentials. Normal shutdown
  removes owned metadata; the broker also releases its own `server.lock`.
- `captures/` contains private client-side snapshots. Normal release/close removes
  this service's captures. `imports/ID.partial` contains unfinished agent-host
  uploads; normal cancellation/disconnect/close removes owned unfinished uploads.
- Published `imports/ID/` files survive disconnect and shutdown, including
  completed uploads whose editor handoff later failed. There is no automatic
  reference-aware garbage collector. Deleting them can break drafts or saved
  conversations; retain or remove only after checking references and retention
  requirements.
- `runtime/` contains owned native worker state, artifacts, caches, and services.
  Successful context cleanup removes non-retained state and owned handles.
  Explicitly persistent/detached native services are preserved, as is state
  needed after cleanup errors. Binding switches are not cleanup events.
- A hard crash can leave captures, partial uploads, runtime directories, or locks.
  There is no blanket startup deletion of old state. Inspect ownership and live
  processes before removing stale data; do not delete the entire root to fix a
  lock or connection issue.

To uninstall, first stop the companion and broker, close owned nonpersistent
work, and unload the integrations. Remove only the generated OMP loader/plugin
files identified by installer output and this plugin's configuration after
checking for local changes. Decide separately whether completed imported assets,
identity, and persistent services should remain. The package does not provide an
`uninstall` command or automatically remove unrelated application settings.
