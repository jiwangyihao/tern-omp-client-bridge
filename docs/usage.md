# Setup and usage

## Binding-authorized native tools (0.5.0)

Update the broker, client service, OMP extension and both Tern plugin halves
together. Copying a package does not upgrade an already-running service or reload
an extension in an existing conversation. Use the host's supported extension/plugin
reload controls; do not reset Tern's daemon state or restart a conversation merely
to repair pane addressing. Existing device credentials are retained. Protocol 2
requires both ends to upgrade together; old grant fields are removed from saved
identities without replacing their keys. Remove obsolete `--allow` launcher flags.

The interactive OMP extension publishes invisible destination metadata in its native
composer dock, without a visible **Client bridge** button or click action. Its locator
names one live authenticated draft channel; it is not a credential. Use Tern's
**Toggle Bridge** entry, which discovers this metadata rather than a pane title or
reconstructed numeric ID. Native rendering, ordinary text and large-paste
choices remain in OMP. Recognized image-path pastes automatically enter OMP's image
loader, including Tern's direct `pasteText` delivery. Binding, explicit text paste and verified attachments are delivered by
the paired broker channel and checked against the captured destination/session/draft.
Submission rotates the draft token; reconnect replaces the locator. A pending
operation never follows focus, adopts the new draft or replays after uncertainty.

Panel diagnostics use the `[omp-client-bridge:panel]` prefix in Tern's native log.
They record plugin load, entry dispatch, target eligibility, panel HTTP response,
target-change checks and native block creation. Random window and operation counters
correlate events without recording session/device/destination IDs, URLs, paths,
user text, tokens or exception messages. Logging is bounded to 40 events plus one
rate-limit marker per 10-second window; logger failure cannot block the action.
An absent entry event is evidence only after the updated plugin's `loaded` event
is observed and rate limiting is excluded. A successful HTTP response alone does
not prove native panel creation; inspect `panel.block.result` and `panel.opened`.

The image adapter subclasses OMP's native `CustomEditor`; it does not introduce a
replacement GUI or a post-drop command. It is installed only into an empty composer
without pending images/text attachments. Existing working drafts are not hot-swapped;
open a fresh OMP conversation/view to enable it after upgrading. The host must expose
the public editor factory. No model selection or model request is needed to attach an image.
Image loading failures keep the native text fallback without retrying it recursively;
explicit raw-text paste callbacks remain literal. Paths must be readable by the OMP
host: a client-only path pasted over SSH is not a file transfer. Tern's native upload
or the Bridge upload entry must stage those bytes first.

Client and broker releases must also agree on transport liveness probes. The
broker challenges the actual Client through the relay every 15 seconds and
releases an unresponsive connection after a 30-second response deadline; a
surviving relay's WebSocket pong does not renew Client ownership. The Client
disconnects after 60 seconds without a valid broker probe. These bounds assume
the process event loops are running; sleep or a stalled process can interrupt
the connection. Relay EOF/output drain is limited to five seconds.

Reconnect preserves the saved identity, but never replays a tool or
human transfer. An already-dispatched operation can have an unknown outcome;
inspect its original destination before retrying. A live duplicate identity is
still rejected. Upgrade Client and broker together: 0.3.1 peers do not implement
these probes and must not be mixed with the updated transport.

Cancelling while an attachment receipt is in flight does not discard that
receipt. The bridge still requests cancellation promptly, but if native OMP has
already accepted the attachment, confirmed handoff remains authoritative and
late cleanup errors do not relabel it as a failed or cancelled upload. Cancellation
does not undo an attachment already handed to OMP.

The running Bridge panel floats over the selected OMP at its top-right corner,
initially focused for interaction. One-time glance/focus initialization uses the
initiating viewer's native window-key-scoped CLI, never a remote daemon focus
command, and preserves later user sizing.
Its public snapshots travel through the authenticated broker, and the host block
closes itself. The installer records `serverControlFile` alongside `controlFile` in
the plugin configuration; by default it is the sibling `server.json` on that host.
Never substitute a client-machine endpoint or put either bearer into a widget/link.
Opening and heartbeat publication are separate operations: a late heartbeat cannot
recreate a closed panel. Closing or relocating the display does not cancel uploads.

This avoids the affected numeric APIs in the running Bridge path; it does not fix
Tern globally or change the separate cold-host setup/bootstrap transport below.
If that older initialization surface is affected, use the documented manual
installation commands rather than deleting daemon state or rewriting pane IDs.

### Agent-host tools do not require a Client

Ordinary server paths and `eval`/`bash` with the default target or `target="agent"`
execute through OMP's native agent-host implementation. They do not require a
connected Client, a selected Client, or a live broker. Native approval and Bash
denial rules remain owned by that OMP runner's Settings instance.

Only Client routes (`target="client"`, `client://` paths and client-owned handles)
require the Bridge's current conversation policy and routing state. Missing state
fails closed for those routes; it never redirects them to the server. Native
`session_branch`, as well as `session_start` and `session_switch`, refreshes the
Bridge conversation identity. A missing Client policy must not disable server tools.


## Initialize from Tern

Use a plugin package/revision containing the root `plugin.toml` (0.3.0 or newer).
Install it through Tern's native plugin installer, then choose **OMP → Set up
Bridge** in the command palette. Installing or loading the plugin does not
download runtimes, contact an SSH host, or start background services.

1. Install only the client-side plugin, then open **Set up Bridge**. If the current
   host already provides the native setup block, its sidebar opens directly.
2. On a cold remote host, review one **interface-only** preparation confirmation.
   The client sends the small UI package through Tern's existing connected-host
   command transport in an owned temporary preparation pane. This stage requires
   no new SSH connection, Bun, SDK dependencies, broker/client, or OMP restart.
   The separate `omp-bridge-setup` package cannot replace a full Bridge installation.
   Choosing the local sidebar instead retains the intended remote installation target.
3. The sidebar shows the selected host once. **Change** expands the connected-host
   list, including one manual SSH option; **Cancel** closes it without retargeting.
   Selecting a server with a known SSH address automatically starts one read-only
   check. Manual or unmapped addresses still require entry and **Check SSH**.
   Merely opening, refreshing or reopening setup does not repeat a successful check.
   This SSH check belongs to the existing full Bridge installation/execution channel,
   not to preparation of the native UI. Display names and opaque device identifiers
   are not inferred as SSH addresses; remembered mappings are exact-address scoped.
4. **Check SSH** performs a bounded read-only check. Authentication, host trust,
   network and platform/tool failures remain beside their retry/edit controls.
   No failure opens a misleading next-step dialog or starts installation.
5. Review the exact destination and scope, then click **Install** in the sidebar.
   Only this action authorizes runtimes, dependencies, integrations and services.
   Unknown-lock recovery is a separate explicit action. Editing the address requires
   another check before installation can be authorized.
   **Edit SSH** returns to the inline field without changing the selected host.
   Review, failure and completion show only their relevant actions, not a disabled
   copy of the whole setup form. **Details** expands optional stage explanations.
6. Progress, failure and readiness stay in the sidebar. Hiding it does not cancel
   an approved background installation; reopening retains its state. Missing
   completion callbacks are marked unverified/interrupted, never inferred successful.
   To finish the view handshake, open Bridge from an OMP conversation on the
   installed remote host with its Bridge extension loaded. An existing compatible
   conversation is sufficient; a local OMP conversation is not that remote target.
   Waiting for local endpoint metadata, host-plugin reload or service upgrades is
   shown separately and does not turn verified installation into a reinstall request.

The target is captured at selection: switching tabs or the current host does not
retarget installation. Replacing/disconnecting the selected native host before
confirmation requires a new selection. Remembered mappings are scoped to exact
connection addresses in native plugin storage; another host's previous SSH target
is never substituted. Existing OMP sessions and bindings are unchanged.

Opening Bridge from another session closes its previous owned display and creates
the display in the caller's current tab, without revealing the old session. Closing
and reopening preserves installation receipts and approved targets; moving the
display never retargets an in-flight transfer or installer. PiP initialization
changes only the newly owned panel; heartbeat publication never reapplies geometry.

Registration alone does not authorize agent operations: manually bind a device
to the intended OMP session. Binding enables native tools under the client's own
Agent policy and OS permissions, without additional plugin capability toggles.
Installation does not modify global runtimes, shell profiles, Tern keybindings,
SSH credentials, or unrelated configuration.
Client registration is authenticated before the plugin's connection is saved.

Managed services survive initializer and SSH command exit. Healthy existing
services are reused without claiming ownership of manually started processes.
An older running package remains identified as such; a staged update is not proof
that a running service has upgraded. Follow any reported reload/upgrade requirement.
An isolated Tern configuration is not automatically reloaded into the default daemon.
**Reload host plugin** and **Service update required** remain explicit attention
states even when an OMP view exists; merely connecting does not complete those gates.

Interrupted setup locks with demonstrably dead owners can be recovered. Unknown
ownership requires the explicit recovery choice in the setup confirmation; first
ensure no other initialization is running. Live owners are never removed.

Private setup progress and logs live beneath this plugin's Tern data directory;
runtime and immutable package releases stay there rather than in the watched
plugin source directory. Do not delete those releases while services or loaders
still reference them. The commands below are advanced/manual alternatives, not
additional steps required after successful plugin-led initialization.

## Prerequisites and roles

The **agent host** runs OMP, the bridge broker, and an SSH server. Each **client
device** runs Tern and its own outbound bridge client in the interactive user's
session. Tern's existing remote connection is not the bridge's executor channel;
the companion client starts its own SSH process.

Runtime requirements on both machines:

- Bun **1.4.3 or newer** and a complete package with pinned dependencies. Plugin-led
  initialization provisions these privately; manual deployment must provide them.
  The native SDK dependencies are pinned to **18.10.4**. Node alone is not the service runtime.
- Filesystem permission to create private bridge state. On Windows, the private
  ACL implementation requires `powershell.exe`.

Additionally:

- The agent host needs a native OMP installation exposing the extension lifecycle,
  native same-name tool delegation, scoped Settings, and interactive editor hooks
  used by SDK 18.10.4. Load through OMP's native extension loader, not an ad hoc
  imported extension object. `install-omp` verifies its candidate using the installed
  OMP executable before replacing the owned entry. Same-volume loader imports use
  canonical relative paths so the host can rewrite SDK imports into its own registry;
  cross-volume Windows entries use the host's exported module loader. A successful
  private Bun import alone is not proof of native extension compatibility.
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

If Tern lists the focused remote pane as an agent but cannot return its native
surface for that same opaque pane ID, Bridge refuses to send input and reports a
native pane-addressing failure. Switching to another conversation or reinstalling
the OMP extension is not a verified fix for that separate Tern API failure. Do not
decode or rewrite pane IDs in the plugin, or select a different pane by its title.

Use a trusted SSH configuration alias, such as `bridge-agent`, for the intended
agent host/account. This alias is an example, not a bundled SSH configuration.
Ensure a normal SSH connection works before starting the bridge.

## Advanced: install from source on both machines

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
bun src/cli.ts install-tern
bun src/cli.ts server
```

`install-omp` writes only
`extensions/tern-omp-client-bridge/index.ts` beneath the native SDK's agent
directory (`getAgentDir()`). Its output reports the actual loader and entrypoint.
It does not edit global settings. To select a different native agent directory,
pass `--target` with that directory; make sure OMP actually uses the same directory.
The loader imports this checkout by file URL, including on Windows. Moving or
removing the checkout breaks it; rerun the installer after relocating.

The remote Tern daemon also needs this package's `host.luau` block definition.
Run `install-tern` on that host using the configuration directory its Tern daemon
actually uses (`--target` for an isolated configuration), then reload its plugins.
This does not move clipboard access or the client UI bearer to the remote host.

Keep `server` running in its terminal. It prints a `broker-ready` record with a
loopback URL and writes private endpoint metadata. An omitted port selects an
ephemeral port; `--port` accepts integers from 1 through 65535. No public listener
or inbound laptop connectivity is needed. Restart OMP yourself after installing
its extension, and open it through Tern's normal remote workflow.

### 2. Client device: install the Tern plugin

```sh
bun src/cli.ts install-tern
```

This installs the root `plugin.toml` and complete package payload, including the
entries beneath `tern/`, into the native Tern plugin directory. It merges
`controlFile`, `serverControlFile`, the machine-local absolute `ternExecutable`
and native daemon route `ternPaneSocket` into this plugin's configuration, preserving unrelated settings. This finite
maintenance command does not start services or reload applications; use
**Set up Bridge** for consented initialization.

Both installation and consented setup resolve the native CLI on the machine
running them: an explicit `--tern-executable` override, a usable saved path,
`PATH`, then bounded platform installation locations. Explicit invalid paths fail
instead of silently selecting another executable. Stable symlink entrypoints are
retained so an application update can replace their targets. For a custom location:

```sh
bun src/cli.ts install-tern --tern-executable "/opt/Tern/bin/tern"
```

On native Windows, pass the actual `.exe`, not a `.cmd`/`.bat` wrapper:

```powershell
bun src/cli.ts install-tern --tern-executable "C:\Program Files\Tern\tern.exe"
```

`setup --tern-executable` refers only to the client device and is never forwarded
over SSH; the agent host resolves its own executable. Spaces and legal filename
characters remain in one argv element, without a shell or global PATH changes.
Windows drive-qualified and UNC executable paths are supported. Do not copy this
machine-local setting between operating systems. If the CLI moves, rerun setup or
the installer with its new path, then reload the plugin. Missing/invalid CLI
metadata blocks new PiP initialization, not independent paste/upload commands.

Native PiP control also needs this machine's daemon socket. Install/setup resolve
`ternPaneSocket` from an explicit `--tern-pane-socket`, a valid saved route,
`TERN_PANE_SOCKET`, `TERN_DAEMON_SOCKET`, then the native default. Linux uses
`$XDG_RUNTIME_DIR/tern/daemon.sock` when that environment variable is set;
otherwise the socket is `daemon.sock` in Tern's settings directory (also the
macOS and native Windows default). Saved routes remain valid during daemon downtime.
An isolated `--target` alone does not identify a daemon: without an explicit or
saved route, installation omits it and PiP initialization requires configuration.
The client socket is never forwarded over SSH. For a custom native daemon:

```sh
bun src/cli.ts install-tern --tern-pane-socket "/absolute/path/to/daemon.sock"
```

Do not start `tern serve` to repair this route: the intended endpoint is the
existing local session daemon, not an independent developer control server.


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
bun src/cli.ts client --host bridge-agent --name Workstation --remote-command 'bun /srv/tern-omp-client-bridge/src/cli.ts relay'
```

Replace the alias and remote installation path with your configured values.
Use an absolute Bun executable path in `--remote-command` if SSH does not inherit
its installation directory in `PATH`. The string is interpreted by the **remote
SSH account's shell**; quote paths with spaces for that shell, not the client's
shell. It must execute only the relay protocol on stdout: shell startup banners
or extra output corrupt that stream. You do not manually run `relay` in a terminal.

A native Windows client can start the same outbound connection in PowerShell:

```powershell
bun src/cli.ts client --host bridge-agent --name WindowsWorkstation --cwd 'C:\Projects\Example' --remote-command 'bun /srv/tern-omp-client-bridge/src/cli.ts relay'
```

The client working directory must already exist. If `--cwd` is omitted, native
execution starts in the client user's home directory, not the agent-host project.
Choose a non-sensitive `--name`; otherwise first-time identity creation uses the
machine hostname as its display name.

`client-ready` means the local UI endpoint is ready, **not** that SSH registration
has succeeded. Check Tern's connection/device status before invoking client tools.
Each client needs its own identity/state directory; do not copy `identity.json`
between machines.

### Bind once; use native safety rules

Manually selecting a paired device authorizes this session's Agent to use its
native file, Bash and Eval tools. Browser/computer helpers follow the client-local
native settings and OS permissions. Installed ADB runs through native execution;
its availability is reported separately from USB/debugging authorization.

There is no plugin capability list or `--allow` option. Stay unbound for human
transfers without agent access. Unbinding prevents new client invocations;
already-dispatched work retains its captured device and native cancellation.

The executor loads the client's own native Agent configuration, not the server's
policy, and preserves native approvals and denials. Binding is not OS isolation:
native code execution can access resources available to that OS account.
See [Security](security.md).

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
bun src/cli.ts client --host bridge-agent --state-dir 'C:\BridgeState' --remote-command 'bun /srv/tern-omp-client-bridge/src/cli.ts relay'
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

On this device, focus the intended remote OMP composer. Human transfers originate
on this viewer, independently of the agent binding, including while unbound.
Native text and image paste remain unchanged: no Paste override, asynchronous
text classification, native-command replay, or additional native-paste gate.
Path-shaped plain text does not instruct the bridge to upload a file.

Click the right-aligned connection/device summary in the window status line, or choose **Toggle Bridge**
from the native command palette, to open the native Bridge Block as a top-right PiP.
The panel shows its originating OMP target and source device, agent selection,
transfers and approvals. **Paste to remote** directly captures clipboard text or
an image; **Upload file** directly opens the system file chooser. Both also have
standalone palette commands; neither opens an intermediate source menu.

**Assign your own shortcut:** the registered action is
`plugin.omp-client-bridge.paste-remote` (palette: **OMP → Paste to remote**).
Merge a chord of your choice into Tern's `settings.json` `keybinds`, for example:

```json
{
  "keybinds": {
    "cmd+alt+v": "plugin.omp-client-bridge.paste-remote"
  }
}
```

The chord is an example, not an installed default; choose an unused chord and
preserve your existing bindings. User bindings override other layers. This
invokes the same explicit one-time paste gesture; ordinary Cmd/Ctrl+V is not
replaced. Focus the intended remote OMP pane first. The separate upload action
is `plugin.omp-client-bridge.upload-file` (palette: **OMP → Upload file**).

Click **Paste to remote** to authorize one clipboard capture. No second Bridge
confirmation is shown. An image becomes a native attachment; otherwise plain
text is pasted into the original draft without submitting it. System permissions
and independently requested native-tool approvals still apply.
Path-shaped clipboard text stays text: it never triggers a file upload. An empty
clipboard reports an error. Terminal control/framing bytes are rejected rather
than executed or silently removed. Native Cmd/Ctrl+V is not overridden.

Choose **Upload file** to open the system file chooser on this device, or drag
a local regular file into the remote composer. macOS uses `NSOpenPanel`, Windows
uses `OpenFileDialog`, and graphical Linux requires `zenity` or `kdialog`.
Select one file and confirm Upload; cancelling uploads nothing. The chooser has
a two-minute deadline and closes if its request or client connection is cancelled.
Images enter OMP's native image-paste handling after upload. Ordinary files enter
a private temporary receiving directory at `STATE_DIR/imports/TRANSFER_ID/` and
their quoted remote paths are appended to the unsent draft. Mixed selections
keep those two paths separate and preserve existing text and attachments. The
bridge neither submits a prompt nor simulates Enter.

Every published receiving directory contains a `README`. Ordinary-file handoff
also adds a draft reminder and a visible notice: **copy/archive the files into
appropriate durable project storage, tell the user where, and work on those
copies—not inside the receiving directory**. The bridge does not choose that
destination or perform the archive automatically. This is guidance, not a
filesystem sandbox. Completed referenced uploads do not expire automatically.
Image-only handoff adds neither file-path prose nor an agent-facing archival
reminder: the agent receives the native image, not a working-directory path.

The right-aligned status control shows connection and agent-device state rather
than the word Bridge: `Connected · Unbound`, `Connected · <device>`, or
`Device offline · <device>`. Device names are capped at 24 Unicode characters.
Without a resolved target it distinguishes `No session` from `Resolving`;
client disconnects show `Disconnected`, and errors show `Needs attention`.
Connection refers to the client/broker link, not proof that a remote OMP pane is usable.
The transfer segment shows `Preparing`, byte-weighted `Uploading 42%`, or
`Handing to OMP`, with the active transfer count when more than one exists.
Unknown upload sizes omit the percentage. Loss of live status shows
`Status unavailable`, not an invented progress value or a promise to resume.
An observed completed handoff shows `Handed to OMP` for five seconds; this does
not mean the prompt was submitted or an image preview finished decoding.
Historical completions do not reappear on reload. Failures and approvals retain
their labeled counts. Progress is aggregated while polling, outside the chrome
formatter's 4 ms budget.
The main control still toggles the owned panel; counts open their respective
detail views. Unbound does not prevent human paste/upload. Uploads continue
independently when the panel closes.
If the status line is hidden, use **Toggle Bridge** rather than enabling it automatically.

The panel is a real plugin Block, not Canvas or an editor replacement. It is
created in a background temporary tab without showing that tab or taking focus,
then floated by exact pane ID over the saved originating OMP owner, still without
taking focus. Tern removes the empty temporary tab; the original tiled tree is
never split, resized or rebuilt, and there is no intermediate visible-tab switch.
Once the floated panel's surface is ready, one native resize initializes a
240×360 logical-pixel glance size and a 360×540 focus size, then a separate native
command focuses the panel. Native frame constraints can limit the displayed size.
This is one-time initialization for the newly created panel, not a permanent size
lock: subsequent user sizes remain, with no polling resize or heartbeat geometry
enforcement.

The plugin invokes the saved absolute `ternExecutable` with `ctl pip resize` and
`ctl pip focus`; it never falls back to a bare `tern` name in the GUI's `PATH`.
`TERN_WINDOW_KEY` is explicitly set to the captured native window key, together
with `TERN_PANE_SOCKET` from the saved local route. A window key alone does not
select daemon forwarding in `tern ctl`; without the socket it can fall back to
the separate developer endpoint `/tmp/tern.sock`. Before each dispatch the plugin
rechecks the current tab and originating OMP context and resolves
the owned panel and owner in that tab's float list to a freshly computed ordinal.
The `"#N"` selector includes literal double quotes for Tern's command parser;
SDK pane aliases are not converted into raw CLI IDs. This is not an exact-ID
size API or an atomic operation: a tab or float-order change between the last
check and command execution can affect another PiP. The user has accepted this
small check/dispatch race; window scoping and rechecks do not eliminate it.

User focus/tab changes, session/host changes, or target loss stop remaining
initialization. Cancellation before floating closes only the owned temporary
panel; cancellation after floating leaves the existing PiP in place. Late process
receipts cannot revive cancelled initialization. Native command failures are
reported rather than treated as successful sizing; an unknown outcome is not
automatically retried. Creation and floating remain shared session-layout
operations. The initiating viewer dispatches sizing and focus once, without
continually restoring either. Another viewer cannot use the panel to read its
own clipboard under the originating window's identity. Opening/focusing never
retargets transfers away from the originating OMP Block.

The panel deliberately uses Tern's UI sans font, control radius, theme colors,
hairlines and hover fills through a stylesheet scoped to its own surface. Bare
plugin surfaces otherwise inherit the terminal monospace font, and plain `el`
buttons have no native chrome by default. Separate narrowly scoped rules style
only this plugin's status segments; the shell path, pane metrics, OMP composer
and other plugins are unchanged.

The compact panel uses a header close control instead of a full-width footer
button. Paste/upload share one action row; agent selection is one row, available
devices are collapsed by default, transfer history is a small header action, and
approvals appear only when pending. Without a live snapshot, it shows a concise
connection empty state rather than unknown fields and a stack of disabled buttons.
The reference-led composition groups the remote workspace, this device, and human
transfer actions in one compact context card. Native icon and item nodes present
devices; transfer rows keep file, phase, and progress together. The visual rationale
and the distinction between website demos and shipped chrome are recorded in
[Tern design reference](research/tern-design-reference.md).

Opening paste/upload/device choosers refreshes expired destination identity before
showing the chooser, instead of consuming the click and requiring another click.
A known conversation or draft replacement aborts preparation. This performs no
clipboard read, file capture, upload or binding change; those still require the
subsequent human choice and existing validation. Already-dropped files retain
the stricter immediate-pinning contract.

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

**Images are handed to the native editor, not pasted as path-only substitutes.**
The supported native image-path formats are PNG, JPEG, GIF and WebP. Other image
formats return an explicit error before bridge draft mutation; export them to a
supported format first. The clipboard reader supplies PNG snapshots. The native
paste interface returns after handoff, while decoding/preview may finish later:
the bridge's `attached` state means handed to OMP, not a separate synchronous
preview acknowledgement. Native image reads and tool screenshots are unaffected.

Use **OMP: Human transfer progress / cancel** to inspect phases, byte counts, and
errors or cancel an unfinished transfer. At most 256 regular files are accepted
per capture; directories and special files are rejected. Completion of an upload
alone is not proof that the editor accepted it. Inspect the draft if the final
receipt is lost; do not blindly repeat a possibly completed transfer. Attached
references cannot be cancelled as partial uploads.

Native input need not pass through bridge validation. The explicit image command
and file-drop path are supplemental entry points. Actual clipboard/GUI gestures,
IME/streaming behavior and Windows/macOS drop targeting require platform evidence.
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
