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

`bun run build` packages the complete native plugin and source tree into `dist/`.
The root `plugin.toml` references entries beneath `tern/`. **Set up Bridge**
provisions a private supported runtime and frozen dependencies after explicit
consent; dependencies are installed for the destination OS, never copied from
another machine. Managed packages live outside Tern's watched plugin directory.
The advanced source-checkout workflow does not require a build. Finite
`install-omp`/`install-tern` commands only install files; the separate consented
setup workflow installs and starts services and attempts the appropriate remote
plugin reload. Neither path restarts active OMP sessions. See [Usage](usage.md).

Unified setup includes POSIX SSH agent-host and macOS/Linux/native-Windows
client-launcher implementations. Trusted noninteractive SSH remains a prerequisite.
Unsupported platforms and missing download/extraction tools fail explicitly;
setup does not bypass host trust, OS permissions, or application sign-in.
Windows implementation is not evidence of a real Windows initialization run.

已发布 `v0.5.0-beta.1` 的 [GitHub Actions 记录](https://github.com/jiwangyihao/tern-omp-client-bridge/actions/runs/40898284516)
显示 macOS 通过、Windows 失败：PowerShell Security 模块无法加载，原生 PTY
测试超时。`v0.5.0-beta.2` 改用直接 .NET ACL API，隔离引导进程的模块路径，
修正 PowerShell 5.1 原子替换的空字符串绑定，并让 ConPTY 测试使用原生 Enter
字节 `\r`。权限检查未被绕过，产品仍保留 PTY 原始输入。旧发布包和历史 CI
结果不因此改变；修复版验证证据与未验收能力见 [verification.md](verification.md)。

Native CLI discovery and launch are machine-local on macOS, Linux and Windows.
Install/setup save an absolute executable path; the window plugin uses it as a
single argv element without a shell. POSIX execute permission is checked;
Windows paths must identify a native `.exe` with a drive-qualified or UNC root.
Saved paths, PATH discovery and conventional installation locations support
GUI environments without a login-shell PATH; custom locations use
`--tern-executable`. A client's path is never reused as the agent host's path.
Path-policy coverage is not evidence of native Windows process/GUI acceptance.
Native control routing is also machine-local: the window child receives the
saved `ternPaneSocket` as `TERN_PANE_SOCKET`, alongside its captured window key.
Linux runtime-directory precedence was checked with the native CLI; macOS
daemon forwarding was exercised without a standalone control endpoint.
Windows Tern 0.9.7 使用 `\\.\pipe\tern-<USERNAME>` 本机命名管道，
不是 settings 目录中的 `daemon.sock`。原生 Windows 已验证安装端解析、
GUI 无端点环境变量时的默认发现，以及通过该管道执行真实窗口 `ctl state`。
显式或已保存的端点仍优先，隔离安装不会从目标目录推断 daemon。
这项只读路由验证不等同于远端会话绑定、传输或桌面控制验收。


The lockfile uses public npm tarball URLs while preserving pinned versions and
integrity hashes. A fresh isolated Linux installation used those URLs with
`--frozen-lockfile --ignore-scripts --production`.

## Platform behavior

| Area | Implemented behavior | Prerequisites / evidence limit |
| --- | --- | --- |
| macOS filesystem and execution | Native Bun/SDK worker, real absolute paths, per-context state. | Native runtime and broker integration have been exercised on one Mac; this does not establish multiple physical machines. |
| Windows filesystem and execution | Native drive-letter/UNC handling, Windows file URLs/ACLs, Windows runtime path handling. | 原生 Windows 已实测权限、文件发布和本机 daemon 控制；设置侧栏已显示。完整远端/跨设备 GUI 验收仍须单独完成，不以 WSL 替代。 |
| Other agent-host platforms | Platform state defaults and broker/relay source are present. | This does not claim all client interactive features are supported there. Clipboard capture is a client-local human operation, not an agent-host clipboard tool. |
| Native shell | Ordinary Bash uses embedded **brush/POSIX** syntax on all platforms, with per-context persistence. | It is not Windows cmd/PowerShell or WSL. Explicitly invoke a different installed shell if needed. |
| Background/PTY | Explicit async and named native PTY services; provenance-preserving process handles. | Automatic Bash backgrounding disabled; unnamed `pty:true` errors because the execution-only worker has no TUI overlay. Service shell is reported separately. |
| Browser | Existing native browser Eval prelude; bridge disables implicit cmux/Tern selection and reports client-owned default backend. | Actual executable/backend startup must succeed. Do not infer Chromium, CDP, relay, or app backends have identical APIs or approvals. |
| Computer | Existing native computer Eval prelude with local confirmation and context ownership. | A real macOS desktop run exercised an owned AppKit window, input, screenshots, control release and in-flight cancellation. Windows and cross-physical-device desktop acceptance remain unproven. |
| ADB | Installed client executable used through existing Bash/Eval; explicit `-s` selection. | Requires Android platform tools, attached/paired device, debugging authorization, and any OS driver permissions. Executable discovery is not device authorization. Physical ADB acceptance remains unproven. |
| Native text paste | Original Tern implementation, without a bridge Paste override, classification, delay, or replay. | Native field routes already bypassed command interception. Restoring text does not verify file/bitmap paste, IME, streaming, or platform GUI acceptance. |
| Human image attachments | Explicit local Paste to remote gesture, or selected-file uploads/drops; supported uploaded images enter native OMP paste handling. | The paste gesture authorizes one capture without a second Bridge dialog. Native paste and OS/tool permissions remain unchanged; actual clipboard/OS gestures still need platform evidence. Handoff does not certify preview completion. |
| Ordinary human files | Selected-file snapshots, verified transfer, real inbox paths, published README and visible archival reminders. | Copy/archive into project storage before working. Native copied-file clipboard handling is not intercepted; cross-pane drop targeting still needs actual GUI evidence. |

Windows 原生终端验证使用实际配置的 Git Bash 和 PowerShell。锁定 SDK
18.10.4 的 `PtySession.startArgv` 对 CMD `/c` 内嵌双引号使用 CRT 转义，
会产生 CMD 不接受的反斜杠引号；这项上游限制尚未修复。不以 `.cmd` 包装
或简化输入宣称任意 CMD command 已兼容。普通 Bash 仍使用 embedded brush。
Windows 的 `process.kill(pid, "SIGTERM")` 是强制终止，不保证执行退出钩子；
恢复流程须按进程归属处理遗留服务记录，而不是把记录存在当成进程仍存活。


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

The bridge exposes native browser integration according to the client's own Agent
settings, while keeping runtime caches and execution contexts isolated.
The default backend is context-owned `headless-chromium`; availability is initially **not probed**. Native
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

An executable or availability flag is not proof of usable desktop control.
The computer backend requires the logged-in interactive desktop, installed native
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
For file uploads and the explicit paste entry, the bridge resolves
the originating OMP context before upload/handoff. Native text/image paste is
left untouched; it is not required to pass through bridge validation. Native
text-field/TSP edits and raw PTY input are distinct routes, which is why the
supplemental command does not claim to intercept every Cmd/Ctrl+V.

The **Paste to remote** native plugin entry directly captures clipboard text/images
after an explicit local gesture, without a second Bridge confirmation. **Upload file**
separately opens the system file chooser. The checked Tern window API has no OS
file chooser, so the local client service opens it:
macOS `NSOpenPanel`, Windows `OpenFileDialog`, or Linux `zenity`/`kdialog`.
Only the authenticated local human endpoint exposes this operation; it is not an
agent tool. macOS dialog display and request-abort cleanup were exercised;
Windows/Linux native dialog behavior remains unverified. No replacement frontend
or host patch is introduced. Native queue/focus behavior
applies after image handoff; there is no new atomic preview-completion contract.

The window-status summary opens a true host-defined Bridge Block in a background
temporary tab with `focus=false`, then uses the window-side `layout.float` API
with `focus=false` to place that exact pane over the saved OMP owner. The host
must have the block installed. There is no intermediate visible-tab switch,
transient split, tiled-tree resize or snapshot/restore of another viewer's layout.
Tern 0.9.7 headless probes with real plugin callbacks preserved a nested,
nonuniform original tree on both the local host and an isolated remote loopback
host; the temporary tab disappeared after floating. Native visual acceptance
is separate from these headless layout results.

One-time native `tern ctl pip resize` initializes 240×360 logical-pixel glance
and 360×540 focus dimensions, subject to native frame constraints, followed by
`tern ctl pip focus`. Both commands run locally with the captured native window
key explicitly supplied as `TERN_WINDOW_KEY`; this is not a `--window` flag or
a remote daemon command. Before each dispatch, the plugin rechecks the current
tab, OMP session/host and owner, then resolves the owned pane and owner in the
current tab's ordered float list to a quoted `"#N"` ordinal. SDK aliases are not
converted to raw CLI pane IDs. There is no exact-ID size setter or atomic
check-and-mutate guarantee: a tab or float-order change after the final check
can redirect the command. The user explicitly accepted that small check/dispatch
race. Window-key scoping prevents selecting a different native window, not this
within-window race. Native process failures are reported, and unknown outcomes
are not retried. Later user sizing is preserved; there is no permanent size lock,
polling resize or geometry enforcement on heartbeat.

Opening and closing panes changes shared session layout. Local actions remain
owned by the originating window and keep the original OMP target while its panel
is focused. Missing owner heartbeats expire the shared display snapshot; closing
the panel does not cancel an admitted upload. Rail/floating-margin rendering and
native click routing still require actual GUI acceptance.

The 0.8.4 drop request has no explicit hovered destination-pane ID. The source
uses the focused eligible remote pane; real GUI evidence must establish its drop
focus behavior before cross-pane drops can be accepted.

Ordinary-file handoff uses synchronous `getEditorText`/`setEditorText` after
asynchronous file validation, rechecks draft identity, and verifies the editor
retained the resulting text. It appends quoted paths to actual agent-host assets,
not opaque local paths or fake attachment markers. It does not submit the prompt.
The remaining GUI acceptance includes ongoing typing, selections/IME, streaming,
session switching, and lost receipt handling.

The earlier fail-closed-all-images scope and assessment of native paste bypass
have been superseded by the user's clarification: native input remains trusted
and unchanged. Supported uploaded images now enter native `pasteToEditor`
handling (PNG/JPEG/GIF/WebP). Ordinary files are published into a private inbox
with a README and visible archival reminders; image-only handoffs do not add
ordinary-file path prose. The terminal transfer label is **Handed to OMP**;
native decoding/preview may complete later. Tool image results remain supported.

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
