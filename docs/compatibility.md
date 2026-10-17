# Compatibility and evidence boundaries

This document distinguishes shipped source behavior, prerequisites, and acceptance
that still needs real platform evidence. It is not a final verification report or
a claim that every native backend works on every OS. Historical
[interface research](research/interface-verification.md) describes bounded probes,
not end-to-end deployment acceptance. Final run evidence is maintained separately
by the integration owner; no build/test totals are asserted here.

## Version and packaging contract

| Component | Requirement / boundary |
| --- | --- |
| Bridge runtime | Bun **>=1.4.3** on the agent host and client; service startup rejects older versions. |
| Native dependencies | OMP SDK packages pinned to **18.10.4** in `package.json` and `bun.lock`. |
| Agent-host OMP | Must expose the compatible native extension lifecycle, same-name tool invocation/metadata, scoped Settings module, and interactive editor hooks. Load probes exercised the installed host and the pinned SDK's bundled CLI, including native execution-target validation; this is not GUI acceptance. |
| Tern | Exported window interfaces checked with **0.8.4**; earlier **0.8.3** evidence remains a historical baseline, not a cross-version guarantee. |
| Python Eval | Locally installed SDK-supported Python interpreter; no automatic Python provisioning. |
| SSH | Native `ssh` executable on the client; trusted host key and noninteractive authentication to the agent host. |
| Package layout | Keep source modules, `src/runtime/worker.ts`, SDK assets, and platform-native dependencies together. This is not a standalone/single-file executable. |

Bun 1.3.14 on macOS was observed to hang awaiting `server.stop(true)` in a minimal
native WebSocket server/client case after both close events. The same case
completed with checksum-verified Bun 1.4.3. This is why the bridge requires the
newer runtime; it is not a reason to replace a user's native OMP/Tern installation.

`bun run build` packages the source tree into `dist/`; dependencies still need
installation with `bun install --frozen-lockfile --ignore-scripts` in the deployed
package. Install platform dependencies on the destination machine rather than
copying another OS's `node_modules`. The documented source-checkout workflow does
not require a build. Installers are finite, preserve unrelated settings, and do
not start services or reload apps. See [Usage](usage.md) for exact commands.

The lockfile uses public npm tarball URLs while preserving pinned versions and
integrity hashes. A fresh isolated Linux installation used those URLs with
`--frozen-lockfile --ignore-scripts --production`.

## Platform behavior

| Area | Implemented behavior | Prerequisites / evidence limit |
| --- | --- | --- |
| macOS filesystem and execution | Native Bun/SDK worker, real absolute paths, per-context state. | Native runtime and broker integration have been exercised on one Mac; this does not establish multiple physical machines. |
| Windows filesystem and execution | Native drive-letter/UNC handling, Windows file URLs/ACLs, Windows runtime path handling. | Must run native Windows Bun/SDK, not WSL. Source coverage is not a Windows process/GUI acceptance result. |
| Other agent-host platforms | Platform state defaults and broker/relay source are present. | This does not claim all client interactive features are supported there. The bridge does not implement clipboard capture on any platform. |
| Native shell | Ordinary Bash uses embedded **brush/POSIX** syntax on all platforms, with per-context persistence. | It is not Windows cmd/PowerShell or WSL. Explicitly invoke a different installed shell if needed. |
| Background/PTY | Explicit async and named native PTY services; provenance-preserving process handles. | Automatic Bash backgrounding disabled; unnamed `pty:true` errors because the execution-only worker has no TUI overlay. Service shell is reported separately. |
| Browser | Existing native browser Eval prelude; bridge disables implicit cmux/Tern selection and reports client-owned default backend. | Actual executable/backend startup must succeed. Do not infer Chromium, CDP, relay, or app backends have identical APIs or approvals. |
| Computer | Existing native computer Eval prelude with local confirmation and context ownership. | A real macOS desktop run exercised an owned AppKit window, input, screenshots, control release and in-flight cancellation. Windows and cross-physical-device desktop acceptance remain unproven. |
| ADB | Installed client executable used through existing Bash/Eval; explicit `-s` selection. | Requires Android platform tools, attached/paired device, debugging authorization, and any OS driver permissions. Executable discovery is not device authorization. Physical ADB acceptance remains unproven. |
| Native text paste | Original Tern implementation, without a bridge Paste override, classification, delay, or replay. | Native field routes already bypassed command interception. Restoring text does not verify file/bitmap paste, IME, streaming, or platform GUI acceptance. |
| Human image attachments | Recognized selected image files are rejected before bridge upload/editor mutation in pure-plugin mode. | Clipboard bitmaps and native bypass routes are not intercepted; universal fail-closed rejection remains blocked. Tool-result image reads/screenshots are unaffected. |
| Ordinary human files | Explicit selected-file snapshots, bounded transfer, verified bytes, quoted remote references in original unsent editor. | Native file Cmd/Ctrl+V remains blocked; pane switching and drag/drop focus behavior require actual Tern/OMP acceptance on each OS. |

## Native backend details

### Execution and filesystem

The companion starts a separate worker per device/session/execution context to
isolate SDK module globals, kernels, shell state, artifact stores, and handles.
JS and Python retain separate native owners and queues. A binding switch neither
resets nor migrates them. Explicit language reset remains scoped to that context.
A broker restart invalidates old contexts; a retained directory is not a durable
kernel checkpoint.

Binding state carries the broker's registration identity (`serverInstance`).
Revisions are ordered only within that identity: a new broker resets the visible
and model-facing target to unbound, and retired-instance callbacks cannot restore
the old selection. Client registration and resolved views use the same identity.

Private input frames use a UTF-8 C1 OSC introducer (`U+009D`) and C1 ST terminator
(`U+009C`), with no Escape prefix or C0 shortcut byte. The native input hook has
no asynchronous raw-key replay; ordinary Escape/navigation/Alt input is not held.
Native GUI tracing showed that BEL (`Ctrl+G`) was consumed before extension input
listeners and invoked the external-editor action. The C1 ST replacement completed
the actual Tern 0.8.4 / OMP 18.11.1-1.1.62 conversation-and-draft handshake without
changing or submitting the composer. Byte-fragmentation and single-character
regressions cover the shared encoder/decoder. Mixed old/new installations are not
supported. This establishes native handshake delivery, not complete paste/drop
or cross-platform GUI acceptance.

Client working directories are native paths and default to the client's home;
the remote OMP project directory is not copied across. Windows URIs use
`client:///C:/...` or authority-free UNC syntax, not `client://device/...`. Native
Windows state on a different volume may require creation of a user-owned junction
under the home directory to satisfy the SDK's home-relative configuration roots.

Results retain native text/images/artifacts and bridge provenance. Existing
filesystem tool schemas and hashline/snapshot checks remain in force. A complete
snapshot header from one device cannot be reused to edit another device's file.
Relative nested operations inside a client Eval remain on the client; ordinary
agent-host calls without client routing keep their native semantics.

This is an execution-only host. It does not supply client-side model completions,
judgment, image questions, or reasoning-agent spawning. The native provider safety
path stays on the outer OMP host. A host loader mismatch or unavailable scoped
policy fails closed rather than substituting global Settings.

Execution schemas are composed through the host validator's own fluent method.
A dependency-local type constructor cannot safely recognize a callable validator
from another bundled host instance. The bundled-host regression checks accepted
agent/client targets, rejected unknown targets, and retained native input rules
without submitting a model prompt.

### Browser

The bridge enables the native browser prelude only when granted and uses isolated
native configuration roots. Its reported default is `headless-chromium`, owned by
the execution context; browser availability is initially **not probed**. Native
Chromium or an explicitly selected supported app/CDP/relay backend must actually
start or connect. The bridge does not silently reuse an agent-host browser,
Tern's embedded browser, another user's profile, or another device's cookies.

Read the selected native backend's documentation for executable selection,
connection, profile ownership, and supported upload/download operations. Upload
paths and downloaded files belong to the browser's client device. Browser tabs
and screenshot handles cannot migrate across device contexts merely because they
share a name. Cleanup is ownership-aware; switching targets is not closing every
tab. Do not extrapolate successful native runtime tests to real browser
navigation, DOM interaction, screenshots, and byte-preserving upload/download;
those require backend-specific evidence.

### Computer and ADB

An executable or capability flag is not proof of usable desktop control. The
computer backend requires the logged-in interactive desktop, installed native
support, OS permissions, and a live local human approval path. A Windows service
session is not a substitute for that desktop. Screenshots/window handles retain
their owner and native coordinate context; neither a binding change nor a renamed
handle authorizes input on another device.

ADB is a local executable used with an explicit serial through existing tools.
`adb` discovery reports executable availability, not device authorization. A real
client-runtime Bash invocation ran ADB 1.0.41 and `adb devices -l`, returned zero
attached devices, and cleaned up successfully. Device shell, logs, screenshots,
and file-transfer acceptance therefore remain unexercised. The bridge does not
install platform tools, accept debugging keys, or publish an unprotected ADB server.

## GUI and attachment boundary

The native plugin requires a connected remote host, a live agent pane, and TSP
`surface.role == "omp.session"`. Shell metadata is not the agent identity: an
actual native OMP pane retained `program: "zsh"` and `at_prompt: true`.
For eligible file drops, the bridge resolves the OMP conversation/draft and pins
that destination. It no longer overrides built-in Paste command dispatch or reads
the ambient clipboard. Plain text stays on the original native implementation,
without asynchronous classification, validation, or command replay. Native
text-field/TSP edits and raw PTY paste are separate routes; actual native
text-field Cmd+V was observed to bypass the former command override.

The reviewed window interfaces lack a safe media-only native paste hook. Native
file/bitmap Cmd/Ctrl+V and fail-closed image rejection on bypass routes therefore
remain blocked acceptance gates, not removed requirements. Restoring native text
does not complete those gates or establish IME/streaming behavior on either OS.
No replacement frontend, alternate shortcut, clipboard watcher, OS hook, or host
patch is substituted for standard Cmd/Ctrl+V acceptance.

The 0.8.4 drop request has no explicit hovered destination-pane ID. The source
uses the focused eligible remote pane; real GUI evidence must establish its drop
focus behavior before cross-pane drops can be accepted.

Ordinary-file handoff uses synchronous `getEditorText`/`setEditorText` after
asynchronous file validation, rechecks draft identity, and verifies the editor
retained the resulting text. It appends quoted paths to actual agent-host assets,
not opaque local paths or fake attachment markers. It does not submit the prompt.
The remaining GUI acceptance includes ongoing typing, selections/IME, streaming,
session switching, and lost receipt handling.

The confirmed **pure-plugin, reduced-image scope** requires human images to fail
closed before upload or editor mutation. The bridge's own capture/transfer path
rejects them, but that is not an end-to-end guarantee for native paste routes that
bypass the bridge. This acceptance requirement remains incomplete. No host patch,
fake success, queued-image workaround, or replacement UI is included. Native
`read` image results and browser/computer screenshots remain supported.

On macOS, Tern 0.8.4 with OMP 18.11.1-1.1.62 accepted ordinary text and
Finder-copied ordinary/PNG files through standard Cmd+V without bridge capture
requests. The files appeared as native cache-path references; source and cached
bytes matched. This used an **in-process remote-loopback daemon on the same Mac**,
not a different machine. It does not establish usable file upload to a real remote
server, native image-preview attachment, or safe asynchronous destination changes.

A separate native connection reached an existing Linux Tern 0.8.3 service using
SSH-key authentication. The foreground-control verification call then timed out;
no native file-paste or remote-byte verification result was obtained. Connection
success is not file-transfer acceptance and does not contradict reported failures
on an actual remote server.

A later isolated native connection used macOS Tern 0.9.0 and a private Linux
Tern 0.8.3 endpoint. A real Linux OMP 18.11.1 composer was visible, with separate
**This device** and **Agent client: Unbound** indicators. The actual extension
observer reported an idle, empty core editor with both routed execution tools
loaded; two independently identified client services were connected. This proves
one real native surface and its conversation handshake, not synchronized UI on
three physical clients or successful native file input. Foreground-control
confirmation timed out before the planned keyboard, clipboard and drop checks.
No fallback input path was used; the owned remote OMP then shut down with exit 0.

## What existing evidence establishes

Real broker HTTP checks exercised authentication, Origin rejection, unbound
failure, and owned metadata cleanup. Integration and real outbound SSH acceptance
used three independently identified runtimes on one Mac against an isolated
Linux broker. Observed checks included synchronized binding/actor state, an active
native Eval remaining on its original device, later execution on the new target,
retained device state, client file/shell operations, and a 1,048,593-byte unbound
human-file transfer with matching destination digest and unchanged source bytes.
Owned clients, relays, forwarding, native contexts, and the remote broker closed.
This is not a mixed three-physical-device or Windows GUI result.

A separate native browser smoke used two owned spawned Chrome 155.0.8059.84
contexts on the Mac. It exercised navigation, DOM updates, isolated retained state,
native image reads/screenshots, real upload/download byte checks, and continued
operation of B after A's disposal. Saved screenshots were visually inspected;
cleanup reported no errors. This was direct runtime acceptance, not browser
operation through SSH, a Windows browser, or a relay/CDP backend.

A separate macOS computer smoke used the actual execution-only runtime and an
owned AppKit counter window. Native AX input changed the visible counter from
zero to one; before/after screenshots were inspected. A second, no-input
foreground grant was cancelled while running. The same worker remained alive,
control was revoked, and the counter remained unchanged. Explicit helper close,
runtime shutdown and fixture termination completed with exit zero and no cleanup
errors. This does not establish Windows, held-key cancellation, SSH routing,
clipboard interaction or provider-generated safety-check acceptance.

Installed-host and bundled-CLI load probes established scoped Settings identity
and native Eval/Bash schema extension without model generation. Native Runner
tests cover child overlays and broker-generation changes. These facts do not
establish compatibility with every OMP version or make off-lifecycle cwd lookup
safe.

Windows-native GUI/desktop execution, cross-physical-device desktop handles,
complete native paste/drop acceptance, and attached-device ADB evidence must be
reported from their real environments. Any browser smoke result must identify
its actual backend and operations. Do not treat a test file, a runnable smoke
script, an installed VM application, or executable discovery as an observed
successful run. Follow the final integration evidence for the exact exercised
revision and remaining limitations.

## Source map

- CLI/defaults: [`src/cli.ts`](../src/cli.ts), [`src/config.ts`](../src/config.ts).
- Installer/package layout: [`scripts/install.ts`](../scripts/install.ts),
  [`scripts/build.ts`](../scripts/build.ts), [`package.json`](../package.json).
- Native integration: [`src/omp/`](../src/omp/), [`tern/window.luau`](../tern/window.luau).
- Worker/environment reporting: [`src/runtime/`](../src/runtime/).
- Paths and provenance: [`src/resources/`](../src/resources/).
- Human capture and published files: [`src/transfers/`](../src/transfers/),
  [`src/uploads.ts`](../src/uploads.ts).
