# Verification record

## Current approved scope

The user approved a unified Paste to remote entry for clipboard text/images and
explicit file uploads, alongside file drops. Native text/image paste remains
trusted and untouched: bypassing bridge validation is
not a defect, and the bridge does not impose post-handoff native queue/focus or
atomic original-draft rules. Earlier fail-closed-all-images and dedicated-entry
rejection assessments are withdrawn.

Images uploaded through the bridge are handed to OMP's native image-paste
handling. Ordinary files become paths in a private temporary receiving inbox,
with a README, agent-visible archival reminder and user notice. The instruction
is to copy/archive into durable project storage, report the chosen destination,
and work on those copies. The bridge neither selects that destination nor
submits a prompt or automatically deletes referenced assets.

The broader original specification remains open for platform/GUI acceptance;
this record does not claim three physical clients, Windows GUI, or attached-device
ADB acceptance.

## October 29: v0.5.0-beta.1 prerelease checks

[GitHub Actions run 40898284516](https://github.com/jiwangyihao/tern-omp-client-bridge/actions/runs/40898284516)
executed the product code at `fcfad878ad826ac819d4c45445a6648a35d8cc64`.
The macOS job passed dependency installation, typecheck, the complete TypeScript
suite, package build and built CLI help. Windows dependency installation and
typecheck passed, but its suite reported 158 passes, 17 skips and 105 failures.
The log includes failure to load the PowerShell Security module for `Set-Acl`
and a native PTY timeout. Windows is a known failing beta target, not an accepted
platform. No permission check was bypassed or failed test skipped to publish.

All five local Luau boundary runners passed: 212 window cases, nine host-panel
cases, 37 setup-controller scenarios, 432 setup-target assertions with nine
read-only POSIX probe cases, and 22 setup-view cases. They are not GUI acceptance.
The source-only tar/zip archives have byte-identical payloads and SHA-256 checks;
the extracted package installs through native `tern plugin install` into an
isolated profile and lists ready with no catalog problems. That check started
no daemon or Bridge service. README/installation-guide local links were checked.

## October 29: native daemon routing from the GUI

After absolute executable launch was repaired, the native command still failed:
the GUI did not provide `TERN_PANE_SOCKET`. A window key alone left `tern ctl`
using the separate `/tmp/tern.sock` developer endpoint. Providing the existing
local session daemon socket made the same read-only `ctl state` request succeed.
Earlier explicit-`--control` smoke checks bypassed this routing branch and did
not establish GUI daemon forwarding. A headless loopback verifier also lacks
the ordinary external session-daemon socket, so it was stopped rather than
reported as equivalent evidence.

Install/setup now persist machine-local `ternPaneSocket`; native window children
receive it together with the captured window key. Saved routes survive daemon
downtime. Isolated file installation without an explicit/saved route remains
unrouted rather than adopting another daemon. Client overrides are not sent to
the remote host. Failed receipts record bounded exit codes and boolean timeout,
JSON/native-success and resize-phase evidence, never raw stdout/stderr.

Verification: TypeScript and 212 shipped-Luau boundary cases passed; 37 local
resolver/setup unit cases passed with three native-platform skips, and 29 native
Linux resolver cases passed with two platform skips. Two source installer cases
and the real isolated setup case passed. The setup case preserves identity and
proves the client's
socket is not copied into the agent host's config. Native macOS `ctl state`
through the ordinary daemon succeeded under GUI-equivalent PATH with no control
port, and a nonexistent window key was rejected rather than routed elsewhere.
Linux runtime-directory precedence was verified with read-only native CLI
probes. Native Windows socket/GUI acceptance remains unverified.

The plugin-only deployment preserved the signed identity, connection metadata and
existing managed client PID 96100. Main-window logs recorded the new plugin load
at 21:13:24.528 +08:00. Desktop control approval returned `unanswered`; no live
panel was clicked and no CLI was used to bypass that boundary. Actual main-window
PiP opening, geometry and focus remain pending foreground authorization.
Owned local and Linux verification directories were removed, the headless verifier
exited, and desktop control was released. No new persistent service was retained.

## October 29: portable absolute native CLI launch

The main macOS GUI process had only `/usr/bin:/bin:/usr/sbin:/sbin` in PATH.
Its panel opened successfully, but the bare `tern` child launch failed with
ENOENT. The terminal-launched headless checks had not reproduced that environment.

Installation and consented setup now save this machine's absolute
`ternExecutable`. The window validates its native path form, pins it into the
owned operation and passes it directly as argv[1], with the existing window key
and quoted ordinal unchanged. Missing CLI metadata blocks new PiP creation, not
independent transfers. Client and agent-host paths are resolved separately;
an explicit client override is not forwarded over SSH. No global PATH or runtime
configuration is changed.

Verification: macOS resolver/setup-unit tests passed (35 cases), as did 168
shipped-window Luau cases and typechecking. Two targeted installer regressions
passed, including launching a saved space/Unicode/apostrophe-containing native
executable with an empty PATH and preserving config after an invalid override.
The real, isolated setup regression passed with different client and host paths,
retaining the selected client path, connection metadata and device identity on
repeat setup. That fixture uses the project-pinned native OMP dependency; a prior
attempt using the independently upgraded global OMP hit its Bun >=1.4.4 minimum.
This task did not change global OMP/Bun or bypass production loader verification.

On the native Linux host, 27 resolver cases passed, including rejecting a parent
editor's unrelated APPIMAGE. The actual Tern 0.9.6 CLI was discovered and launched
with PATH restricted to `/usr/bin:/bin`. On macOS, a real Tern 0.9.7 headless plugin
loaded installer-produced config and the shipped command-launch helper under
the exact GUI PATH above. Its saved executable path contained spaces, an apostrophe
and Unicode. Both native resize and focus commands exited 0 and produced 240×360
glance / 360×540 focus settings. Only control-endpoint routing was scoped to the
isolated fixture; executable lookup was not replaced.

Windows drive, UNC, extended-path and `.exe` lexical/consumer cases passed on the
available runners. Native Windows discovery/process/GUI cases remain unexecuted;
macOS/Linux results are not a Windows platform-acceptance claim.

## October 29: background tabs and portrait glance/focus

The user accepted the small current-tab ordinal check/dispatch race. The panel
now opens in a background temporary tab and floats over its exact saved owner
without showing the temporary tab. A window-key-scoped native CLI resize sets
glance size to 240×360 and focused size to 360×540; a separately checked command
then focuses that panel. The quoted ordinal is recomputed before each command.
There is no ongoing resize, focus traversal or split-divider sizing sequence.

Verification: 136 behavior-focused shipped-Luau routing cases and TypeScript
`tsc --noEmit` passed. Cases cover delayed/failed process receipts, cancellation,
replacement owners, background creation, an unrelated existing PiP, changed
ordinals and preserving user sizes. A read-only CLI call with a nonexistent
`TERN_WINDOW_KEY` returned `no Tern window on this machine shows this pane`,
rather than returning another window's state. `ctl --window` is not supported;
the implementation uses the native context's explicit environment key instead.

A Tern 0.9.7 headless remote-loopback smoke loaded the shipped initialization
functions into a real window/host plugin. OMP destination metadata was synthetic
and timer steps were advanced through fresh native callbacks; layout, surfaces,
child processes and PiP commands were real. The fixture explicitly scoped child
control commands to its own endpoint. It verified background focus/root retention,
selection of ordinal 2 while ordinal 1's sizes stayed unchanged, portrait native
rectangles in both modes, and manual focus size 410×610 surviving focus changes.
Only the initial resize/focus pair was issued. An unobscured native offscreen
screenshot also showed the unfocused panel in portrait orientation.

These results supersede the glance-size blocker at the earlier checkpoint below.
The implementation does not claim an atomic or exact-ID size operation; a change
between checking and dispatch remains the user-accepted risk. Main-window visual
interaction, clipboard and physical multi-device acceptance were not exercised
by this isolated smoke.

## October 29: cross-tab PiP creation

The panel is now created in a temporary tab and floated by its exact window-API
pane ID over the captured OMP owner. The original tab is never transiently split
or reconstructed. Native placement failure or pre-float cancellation requests
only the owned panel's broker-driven self-close. An unresolved broker view cache
does not imply a closed target: initialization validates the actual original
OMP surface's destination marker, host attachment and tab instead.

Verification: 107 shipped-Luau routing cases passed, including nonuniform nested
trees, temporary-tab removal, false/throw placement failures, context changes,
owner replacement and preserving user sizing across polling and paste. TypeScript
`tsc --noEmit` passed. A separate Tern 0.9.7 (`c2f7563`) headless process loaded a
real window/host plugin and exercised new-tab creation, exact-owner floating and
closure on both its local host and an in-process remote loopback host. Three-pane
roots with ratios 0.5 and 0.550000011920929 remained unchanged; floating removed
the empty temporary tab and closure removed only the probe panel. Exact-pane
surface lookup also read an unfocused plugin surface on the remote replica.

This is native headless layout evidence, not main-window visual acceptance.
At this earlier checkpoint, glance-mode portrait initialization was unresolved.
Native `pip resize` set glance and focus dimensions differently, but its target
selector was an active-tab ordinal; `layout.resize` returned false for a floating
pane. No exact-pane glance-size setter was found. Ordinal dispatch had not yet
been accepted; the subsequent background/portrait implementation above resolves
that blocker under the user's explicitly accepted race. Desktop authorization was
not required for these isolated checks, and no live clipboard or user agent was
operated.

## Main-window panel failures reported October 26

The user reported that neither the remote OMP widget nor the main Tern plugin
entry opens its panel, while a local-session click produces Needs attention.
Read-only inspection found the installed 0.5.0 plugin ready and the Client
connected, but no retained panel. Those checks do not establish click delivery
or main-window usability; the earlier isolated-window pass does not cover this.

The local unsupported-context path incorrectly called the global error reporter.
The source now gives informational context feedback without setting or clearing
actual connection/panel errors. The new regression fails against the installed
window module and passes against the changed source: 73 shipped-Luau behavior
cases passed. This source fix is not yet installed or native-UI verified.

The remote no-panel cause remains unresolved. Current focus versus clicked pane,
native link dispatch and current-host block creation remain hypotheses, not
confirmed causes. The user chose read-only main-window inspection and will perform
clicks. No working-session input, host switching, restart or plugin reload was
performed for this investigation. Further native verification requires the
user-triggered failure feedback; do not claim both reported defects fixed.

### Invisible locator and bounded panel diagnostics

The subsequent source change removes the visible Client bridge label and click
action while preserving hidden native destination metadata for Tern discovery.
Panel diagnostics now cover entry, target selection, HTTP response and native
block creation, with bounded redacted fields and failure-isolated logging.
Startup logging does not add a timer or alter initial polling order.

Typecheck passed. The native-editor integration suite passed 20 cases with 203
assertions, including destination discovery and preservation of the unsent draft.
The shipped Luau routing harness passed 75 cases, including diagnostic rate
limiting, logger failure and unsupported-context behavior. These are synthetic
SDK-boundary checks, not a real Tern visual acceptance or proof that hidden nodes
remain discoverable through the actual Tern surface exporter.

The user subsequently authorized deployment and supported plugin reload, without
working-session input or restarting Tern/OMP. Release
`d829e1d405d634868d70f7f5ec771af13e5011be1b8706cbc657231f21fd7b9e`
was installed on both ends. Local and remote Tern reload reported ready. The
actual main-window native log emitted `[omp-client-bridge:panel]` with event
`loaded`; a fresh screenshot/AX observation showed `Connected · No session`
on the user's current browser pane. No tab switching or working-session input
was performed. This proves native logging loads, not remote panel opening.

Setup retained the old remote broker (PID 2151375, digest `115d6268…`) and reported
`awaiting-service-upgrade`, with no active OMP view handshake. The local managed
Client started on the new release (PID 71540). Existing OMP processes were not
reloaded or restarted, so their already-loaded visible widget may remain until
the user loads the updated extension. Real hidden-locator discovery and panel
opening remain unverified. Old immutable releases are retained because live
processes may still import them; existing dependencies were reused.

### October 28 private panel URL timeout repair

The main Tern window reproduced `route.link exceeded 50 ms`, followed by an
`open_url` failure for the private panel paste URL, despite opening the chooser.
The route now returns handled before surface inspection, HTTP or chooser work;
deferred execution revalidates the captured panel URL and pane with fresh context.
The source routing harness passed 82 cases, including seven deferred-action
ordering and stale-target regressions. The updated local window plugin was
installed with install-tern and reloaded without restarting OMP or Bridge services.

In the dedicated remote `Bridge-Paste-Verify-20261028` session, native OMP 18.13.1
was discovered without a visible Client bridge widget. Bridge opened successfully;
Paste to remote opened its native chooser twice, with cancellation between attempts,
without the macOS URL-handler dialog or a new route timeout in the observed log.
No clipboard payload was read or transferred and no model prompt was submitted.

The approved outermost 75/25 sidebar remains blocked by the installed host API:
TabTree is readable but has no live-root setter; TabSpec starts new panes, and
arrange cannot preserve arbitrary nested ratios. Official layout documentation
and the generated installed SDK were checked. No host source checkout was found.
No replacement processes, approximate width or flattened layout were substituted.

### PiP placement investigation (October 28)

The user superseded the tiled sidebar proposal with target-owned top-right PiP.
In the isolated remote Bridge-PiP-Verify-20261028 session, numeric lookup of both
the returned panel ID and original target ID returned nil while the focused
surface remained valid. layout:float refused with a needs-another-tiled-block
error, including after waiting for pane creation. A separate native-action
experiment used the verified `pip` and `pip_corner:top_right` actions against
the panel's own verified surface. It exceeded the native 50ms budget both from
pane_created and from a deferred await callback. Neither attempt established
a usable PiP; synthetic passing checks were not counted as native acceptance.

Failed PiP code, temporary diagnostics and its synthetic fixtures were removed.
The working deferred-private-route implementation was reinstalled; all 82
routing cases passed. The desktop locked before the separate native-command
geometry experiment, so default expansion, clickability and aspect ratio remain
unverified. The idle owned test session was closed after checking exact name,
host and running command; no existing agent was restarted or given input.

Subsequent native-command testing in Bridge-PiP-Native-20261028 succeeded:
with only the owned Bridge focused, `tern ctl pip float tr` created a PiP
whose AX label was `Bridge, top right, over omp`. The native state initially
reported glance mode at 480x280 logical pixels. `pip focus "#1"` followed by
`pip resize "#1" 340 560` produced focus mode at 340x560, corner tr. The
expanded PiP's Paste to remote button opened the real chooser successfully;
no clipboard contents were read. The OMP tiled pane regained its full width.
These observations establish native PiP usability, not automatic plugin setup.
An earlier callback timeout does not prove that a native side effect never ran.

For asynchronous plugin integration, a bounded process probe found no inherited
TERN_WINDOW_KEY or TERN_WINDOW_SOCKET. The window-title metadata exposed only
tab, cwd, tabs, space and pane, not a control endpoint. An unscoped CLI process
could operate another window or a newly focused pane, so it was not shipped as
an automatic fallback. Temporary probes were removed; the existing working
Bridge implementation remains installed pending a verified scoped dispatch path.

#### Viewer-local automatic PiP candidate

Single-action native probes subsequently demonstrated that returning `cx:action`
at the callback tail avoids the previously observed chained-action timeout in
those probes. Local `next_pane` focused the owned PiP; the top-right corner action
worked after focus. Starting at 720x420 logical pixels, right reduced width by
32 and down increased height by 32. These are individual-action observations,
not acceptance of the complete automatic sequence.

The source candidate now uses fresh deferred callbacks, one native action per
callback, bounded focus traversal, and owned-surface validation before geometry
changes. It requests 12 right and four down steps (336x548 from the observed
default), then stops geometry writes. Session/host changes, missing original
panes, lost panel focus during sizing, and the deadline stop initialization.
No remote daemon focus command or numeric pane mutation API is used. Rounded
pane IDs are not used to identify visited panes; exact panel ownership still
uses the existing surface marker and broker destination.

All 93 synthetic routing cases passed, including cancellation and preserved
destination behavior. Whole-sequence native acceptance was initially blocked: the
Mac locked and renewed desktop-control approval returned `unanswered`. Native logs
also contain timer-budget failures at 18:24:42 and 18:26:02; their cause has not
been attributed to the new PiP sequence. No visual success is inferred from
locked-screen captures or synthetic results.

The first candidate was briefly installed, then its automatic PiP helper and
trigger were removed from the installed window plugin while verification was
blocked. Source and regressions were retained; the temporary control-target
probe file was removed. No GUI reload or session close was attempted without
renewed control during that blocked phase.

#### Unlocked native acceptance and deployment

After renewed interactive desktop approval, the candidate was installed and
reloaded without restarting OMP or Bridge services. In the existing remote
Bridge-Daemon-PiP-20261028 test session, the real status entry automatically
produced `Bridge, top right, over omp`, focus mode, at 336x548 logical pixels.
Native logs recorded `panel.pip.ready`; the OMP tiled area regained its full
width. Paste to remote opened the actual source chooser and cancellation worked;
no clipboard payload was read or transferred.

One early close/reopen observation timed out: the authoritative remote layout
still held the panel while the local viewer did not show it. No deterministic
cause was established. Temporary phase diagnostics were removed before final
acceptance. With the probe-free implementation, both the panel's Hide Bridge
path and the owner status-toggle path closed and reopened successfully at
336x548 in focus mode. Closing restored the OMP to 162x49 cells. Leaving focus
uses native glance/visibility behavior rather than forcing the PiP to stay
expanded. These observations are not a multi-viewer isolation stress test and
do not establish that all intermittent native visibility issues are eliminated.

The probe-free implementation remains installed and loaded. README and usage
documentation now describe one-time PiP initialization rather than the old tiled
sidebar. No remote daemon focus command or input into another agent was used.
When the user switched to another working session, cleanup did not switch that
viewer back. The exact owned test pane was closed through the authoritative
daemon; subsequent inspection showed an empty retained pane with title/program
empty and live=false. Tern retained the test session and empty placeholder, but
the owned OMP process and Bridge panel were no longer live. No new resident
process was created in this continuation.








## Binding-authorized native tools (0.5.0)

The user approved removing the plugin-specific capability-grant system. Manual
binding authorizes native tools for that session, subject to client-local native
Agent policy and OS permissions. There is no `--allow` option or capability list.
Protocol 2 rejects mixed old/new peers; legacy identity migration retains the
device ID and keys while dropping the obsolete grant field.

The executor reads native global, project and explicit client configuration
without modifying those files. Runtime isolation preserves that effective policy
for both session-aware tools and native SDK singleton consumers. Provider-facing
safety and local native confirmations remain in force; the plugin adds no new
grant prompt or forced allow/deny map.

A standalone smoke launched the shipped broker CLI and real Client service with
native tools. Unbound execution was rejected; manual binding enabled a real Bash
call returning `Darwin` and `binding-native-ok`; a second invocation retained its
shell variable. A client-local native write denial prevented file creation, and
unbinding rejected new execution. The first smoke harness used an invalid bare
client path, then expected a denial result instead of the actual thrown native
error; neither attempt is counted as a pass. The corrected scenario passed and
its temporary script/processes/state were removed.

Typecheck passed. The scoped source suite passed 211 tests, skipped one
platform-specific case, and failed zero (1,682 assertions across 27 files).
Shipped Luau behavior checks passed 67 routing cases and 22 setup-renderer cases.
The initial broad test filters accidentally included distribution copies; scripts
now use explicit relative test paths. A new binding fixture also exposed concurrent
Broker/Client shutdown racing context disposal; orderly fixture teardown passed.
These are not native Windows or physical Android evidence. Earlier grant-related
sections below describe historical releases, not the authorization contract of 0.5.0.

The approved production cutover installed 0.5.0 on both ends, release digest
`115d6268389dbc92d1829acd9a66b3e8ac08585f871aac0b41474c48b5be40ad`.
Both managed services reported `upgradeRequired: false`; setup reported ready.
Before/after comparison confirmed identical device ID, public key and private key,
with no remaining capability field. Local and remote plugins reported ready.

In the existing acceptance window 892, the real device picker displayed binding
authorization under native safety rules instead of capability categories. An old
OMP process retained capability-schema errors after `/reload`; only that owned
acceptance process was reopened with its saved history. Working conversations
were not restarted. Existing old processes may need the same user-timed reopen;
do not treat a plugin reload alone as proof that their imported code changed.

The upgraded remote Agent then used native Write and Read on
`client:///tmp/bridge-binding-v2-892.txt`, returning the exact `BINDING_V2_OK`
content, native client Bash returned `Darwin`, and client JS Eval returned
`darwin`. Raw tool receipts recorded `isError: false`, the same Mac identity and
binding revision 1 without a capability field. The Agent removed only the
synthetic file; local inspection confirmed it no longer existed. No extra grants,
policy changes or SSH execution substitutions were used for these operations.



## Agent-host availability across conversation transitions

The extension previously checked its captured conversation policy before routing
every tool, including native agent-host calls. The installed SDK also emits
`session_branch` after changing conversation identity; the extension handled only
start/switch. A real SDK session reproduced the same missing-scoped-Settings error
on an ordinary server-file read after the manager changed identity.

The fix delegates agent-host routes before checking Client policy, retains native
approval against the runner-owned Settings object, and refreshes Bridge identity
on `session_branch`. No global or same-directory sibling Settings lookup is added.
Client routes still fail closed while their conversation policy is unavailable.

`omp-agent-local.test.ts` exercises real native Read, Write, Bash and Eval through
the live registered overrides, without a Client service or broker. It covers the
conversation-transition interval, default and explicit agent execution, shared
native Eval state, preserved Bash pattern denial, and branch-policy refresh.
Type checking and 42 tests across seven relevant files passed (357 assertions).
A separate standalone SDK smoke executed server-file reads, Bash and Eval without
a Client/broker, verified native denial and Client-route rejection, then verified
server-file access after `session_branch`; every reported check passed. The
throwaway smoke script and temporary files were removed. This is source/runtime
verification, not proof that an already-running remote conversation reloaded it.

### Installed 0.3.1 hotfix and production reconnection

The compatible 0.3.1 release is installed on the Mac and a POSIX agent host; both
managed services use package digest
`53061e8f177f7a16cc701f00ab7f56d41a2a30100ed142bd88e84b544c04518c`.
This is the agent-host availability hotfix, not deployment of the pending
0.4.0 native-destination implementation. The source release suite reported
186 passes, one Windows-only skip and zero failures before deployment.

The authorized reported conversation was resumed with its history. OMP later
reported that the original session file had another writer and saved subsequent
work to `2026-10-22T17-18-56-968Z_01a1649f-7fc8-7069-a1a8-6242faedf727.jsonl`
rather than mixing entries into that file. Read-only inspection found successful
Read, Write, Bash and Eval results and no missing-scoped-Settings error results
in that file. Other OMP conversations were not restarted by this recovery.

Production Client readiness initially remained false despite broker registration.
A no-capability synthetic identity registered successfully; the saved production
identity instead received `DUPLICATE_CLIENT`. Remote relay PID 1435788, retained
from the earlier connection, still held a broker socket after its local owner
was gone. After verifying its exact release path and relay command, only that
relay was terminated. The existing managed Client reconnected automatically;
three authenticated observations four seconds apart reported `connected: true`.
Identity and capability grants were preserved, and the broker was not restarted.
This repairs the observed stale ownership, not proof of automatic recovery from
every half-open SSH connection.

There were zero resolved views and zero transfers in those observations:
transport recovery does not establish a production native-view handshake.
Sidebar heartbeat, multiple windows, stale-draft delivery, unified clipboard
entry and physical drag acceptance remain separate gates, not hotfix passes.

### Bounded transport recovery and native receipt cancellation fixes

The pending 0.4.0 source now probes end-to-end Client liveness, rather than
treating a surviving relay WebSocket as proof of a live Client. Actual broker,
relay and Client reproductions retained `DUPLICATE_CLIENT` before the fix and
reconnected the same identity automatically after the fix; the orphan relay
settled and grants were unchanged. Broker probes run every 15 seconds with a
30-second response deadline; Client silence expires after 60 seconds. A blocked
relay EOF drain now fails after five seconds. Duplicate identity protection and
unknown-outcome/no-replay semantics remain in force. Matching Client and broker
versions are required; production 0.3.1 was not replaced by this candidate.

Two real native-editor reproductions also found cancellation races: cancelling
before an attach receipt arrived discarded completion correlation, and a late
cleanup failure could add an error after confirmed handoff. Both were fixed in
`client.ts`. Actual broker/client/upload/native-controller smoke cases observed
one attachment request, preserved source bytes, retained draft contents, native
image handoff, zero submissions and authoritative `attached` completion.

The focused native-editor, Client-service and draft run passed 74 tests with
641 assertions. The shipped window routing harness passed 67 synthetic cases;
these do not certify physical paste, drag or multi-window gestures. Dedicated
transport cases have focused passing evidence, but a subsequent full local run
was interrupted during documented clamshell sleep intervals and did not pass.
Unrelated native tests also exceeded their deadlines; production timeouts were
not relaxed to hide these results. Isolated Linux critical coverage passed 91
tests (752 assertions). A complete portable source payload subsequently passed
198 tests, one Windows-only skip and zero failures (1615 assertions, 26 files).
An earlier incomplete verification archive omitted docs and included macOS
AppleDouble files; its packaging/parser failures were corrected in the harness
payload, not hidden by modifying production behavior.

Task-scoped desktop confirmation initially returned `unanswered`; the documented
per-call native computer interface subsequently launched and inspected an owned
Tern fixture. A lock-screen interruption was resolved by the user unlocking the
Mac. No alternative desktop controller or approval bypass was used.

In that actual window, the old queue received HTTP 200 responses but stranded
deferred work and eventually lost the sidebar lease. Timer retention, awaitable
sleep at the old queue boundary and forced redraw experiments did not establish
a fix and were removed. The source now uses the fresh context already provided
by native HTTP completion and native zero-delay await callbacks for deferred UI
work, eliminating the redundant single-flight timer queue. A pass-through HTTP
observer measured 90 state polls and nine successful publications over 45 seconds,
with publication gaps of 5.04–5.137 seconds. The sidebar remained Connected during
subsequent operations. The observer was removed; clean plugin reload and reopening
retained the original draft and attachment without model submission. New window
owners do not adopt older view-scoped transfer history.

The unified native clipboard entry preserved an existing unsent draft while
appending multiline Unicode text. The user selected `AGENTS.md` through the native
file picker: 671/671 bytes, `attached`, matching SHA-256, archival guidance in the
original draft, zero submitted/rejected inputs, and a still-connected sidebar.
A second real native window without an eligible OMP destination rejected Toggle
Bridge without changing the originating draft. This is not proof of every
two-OMP-window or stale-conversation physical gesture.

Android discovery returned zero attached devices. Two isolated browser attempts
failed (approval-wait deadline, then a closed CDP session after a prolonged wait);
both reported successful cleanup. Physical file drag, image clipboard, complete
two-OMP-window gestures and native Windows/Android acceptance remain open. The
isolated window later exited before the authorized foreground drag could start;
its draft observation, selected file and private logs were retained. No drop was
attempted into the unrelated foreground work session.

### Native image-drop failure boundary (model-independent)

A subsequent isolated Tern 0.9.5 / OMP 18.12.6 native GUI run copied a
71-byte ordinary file into Tern's attachment cache with matching SHA-256 and
preserved the unsent draft. This was Tern-native path insertion, not a Bridge
transfer. Dropping a 68-byte PNG likewise produced a matching cached file and
path text, but no observed image attachment. A non-consuming routing probe
reported `No drop route observed`; this composer gesture did not reach the
Bridge's file-open hook. No model was selected or requested.

A separate executable comparison using the pinned 18.10.4 SDK and the existing
native-draft fixture passed with the same cached PNG: native `edit` left path
text and zero images; `pasteToEditor` produced one pending image, retained the
draft and submitted nothing. In-memory Settings initialization was required by
the fixture; the initial harness omitted it and failed before attachment. The
corrected comparison used no model configuration or model request. This proves
the pinned SDK delivery distinction, not an installed-host patch or GUI fix.

The official [TSP native editing contract](https://docs.stencil.so/tern/protocol/input.html#native-editing)
defines text edits, while [file-open routing](https://docs.stencil.so/tern/guides/routing.html#open-requests)
does not promise composer attachment delivery. This does not establish that a
new Tern protocol is required: OMP's existing TUI paste classifier already
converts recognized image-path text into attachments without requiring drop
provenance (`custom-editor.ts:1579-1586`). Its large-paste interaction also offers
explicit presentation choices (`input-controller.ts:2500-2535`). An explicit
path-versus-attachment choice can resolve intent without identifying the gesture.
The earlier conclusion that missing drop provenance prevents a Bridge-side
solution is withdrawn. The initial native drag attempt failed; the subsequent
automatic adapter and physical acceptance below supersede that failure.

### Automatic native image attachment acceptance

An instrumented installed OMP 18.12.6 run showed the actual GUI paste entering
`pasteText` directly, bypassing `handleInput` and `handleNativeEvent`. The first
edit-only candidate passed its SDK smoke but failed that real GUI path. The final
`NativeAttachmentEditor` also handles direct paste and delegates image loading to
the native bracketed-paste pipeline. Async-local callback scope prevents loader
text fallback from recursively attempting the same image; diagnostics were removed.

In isolated real Tern 0.9.5 windows, Cmd+V of a PNG path produced the native image
chip without a model. A subsequent Finder drag of `drop.png` produced image `#1`
in the pre-existing synthetic draft; dragging `drop.txt` next retained that draft
and image and appended the ordinary file's native cache path. The copied image
was 68 bytes and the ordinary file 41 bytes, both matching source SHA-256.
The observer recorded zero submitted/rejected prompts and an idle session.
These are real native gestures on a same-Mac remote-loopback host, not physical
SSH, Windows or Android acceptance. The new image adapter has not yet been
asserted deployed into the production GUI.

The focused native-editor suite passed 20 tests / 202 assertions; typecheck passed.
New regression cases exercise direct GUI paste, surrounding prose, selection
replacement, stale edits, invalid-image text fallback and Enter waiting for the
real image loader. No model or real clipboard is used by those regression tests.

Two real isolated native windows retained independent drafts during text paste.
The first window retained its synthetic prose, image and ordinary-file path while
the second received independent text. A real `ExtensionCommandContext.newSession`
transition in the second window changed the session ID without restarting its
OMP process. Reusing the captured pre-switch destination returned HTTP 400
`DESTINATION_CHANGED`; the new draft stayed empty and the first remained intact.
No model input was submitted. The acceptance observer explicitly permits only its
two registered local commands because OMP input hooks run before command dispatch;
all other submissions remain intercepted. This is same-Mac native-loopback proof,
not a claim about production SSH or other operating systems.

### Installed image adapter and real SSH acceptance on October 25

The image adapter release was built and installed on both ends with package digest
`65761867baa0d144be686a4162db2b22a7ba5a6b12397ea6ee88e56d5c6c6863`.
The stopped local Client was restored. The verified obsolete managed broker was
gracefully replaced; both services subsequently reported `upgradeRequired: false`.
Saved device identity and empty capability grants were retained. Local and remote
Tern plugin reloads reported ready without restarting working OMP conversations.

Acceptance window 892 connected over SSH to the configured agent host and started a fresh
OMP 18.12.6 in `/tmp`. Its isolated plugin configuration was pointed at the live
Client endpoint rather than the earlier loopback fixture. The authenticated view
resolved session `01a1729b-0441-74ff-b7e5-997c7b161f1e`; its real Bridge panel
rendered Connected, Paste to remote and Upload file.

After explicit human approval, the unified clipboard entry inserted
`BRIDGE_ACCEPTANCE_TEXT_892` into that remote unsent draft. The original clipboard
was restored. An earlier request expired while awaiting approval and did not
insert text. The system file picker opened, but its accessibility window could
not accept background keyboard input. Foreground-control confirmation remained
unanswered; no image/mixed-file GUI pass is claimed for this SSH run.

An operator-targeting error initially opened a tab in the user's working window
36 and attempted shell input before UserIntervened stopped delivery. The user
corrected the target; all subsequent desktop actions were confined to acceptance
window 892 and its owned picker. The user-touched tab/input was not overwritten
or automatically cleaned up.

### Revised terminal acceptance and authorized Client execution

The user replaced attached-Android acceptance for this round with actual remote
Agent execution of the local terminal, and explicitly deferred native Windows
acceptance until a device is provided. No physical ADB result is inferred from
terminal success; USB/driver/debugging authorization remains a separate boundary.

The existing Client identity was retained and granted `exec` through the same
validated identity-loading API used by `client --allow`. Only the idle managed
Client was restarted. Its authenticated state advertised `["exec"]`; other
capabilities were not added. This is a coarse arbitrary-code execution grant,
not filesystem or OS sandboxing.

In acceptance window 892, the real remote OMP Agent performed three actual Bash
tool calls in session `01a1729b-0441-74ff-b7e5-997c7b161f1e`:

- `target: client`: returned `Darwin` and the expected local account/home directory
  (machine-specific values redacted), plus `CLIENT_PROBE_892`.
- A separate `target: client` call returned the previously exported value
  `acceptance_892_20261025`, proving persistent shell state across invocations.
- `target: agent`: returned `Linux`, distinguishing the remote execution host.

The actual session JSONL tool results all recorded `isError: false`. Both Client
results carried the original device ID, `darwin/arm64`, `exec`, binding revision 1,
and distinct request IDs. The native UI also displayed the completed results.
No SSH command was used as a substitute for either Client tool invocation;
read-only SSH inspection afterward verified the recorded tool results.
This proves remote-Agent-to-local-shell execution, not browser, physical Android,
native Windows, or OS terminal-window automation acceptance.

### User-authorized production cutover to 0.4.0

After explicit approval to synchronize both sides without restarting working OMP
sessions, the native release was built and its CLI help executed successfully.
Installed Client, broker, OMP loader and both Tern plugin copies now use 0.4.0,
package digest `647157af594b1b86ab7a2af50db8239909a81648463ae2ffdfb282ab19df9632`.
The initial setup refused the old live Client's incompatible readiness schema;
its owner and authenticated idle state were checked before an explicit graceful
cutover. No unrelated process or OMP conversation was restarted.

The replacement broker and Client reported `upgradeRequired: false`. Authenticated
Client state remained connected after 197 seconds; the saved device identity and
empty capability grants were unchanged, with no active transfers or approvals.
The complete setup result is still `awaiting_session`, not production GUI-ready:
no view has yet completed the new native handshake. Old live conversations must
reload their extension or a new OMP view must be selected. The Mac was locked
again at the final desktop check, so no production window handoff is asserted.

Owned cutover scripts, portable verification archives and Linux test workspaces
were removed. Old managed release packages remain available for already-running
imports; user-selected attachment data and native acceptance evidence were kept.



## Native extension loader compatibility and pane lookup diagnosis

The remote OMP 18.12.5 extension failure was not missing installed dependencies:
the private Bun runtime could import the factory, but the generated `file://`
wrapper bypassed OMP's native module-graph SDK rewrite. The installer now generates
canonical relative imports (or the host module loader for Windows cross-volume
paths) and verifies the candidate in an isolated installed OMP process before
replacement. Candidate lifecycle handlers are observed but never registered;
stdin EOF terminates the verifier without a model request or broker activation.

The actual remote 18.12.5 executable accepted both the staged candidate and the
installed loader. Only the owned loader was atomically replaced, with its previous
contents backed up. Immutable package source, dependencies, service processes,
sessions, identities and grants were not replaced or restarted. A live conversation
that previously failed extension loading still needs a supported extension reload.

Verification: typecheck passed; loader/scoped-policy/schema/packaging tests passed
24 cases with one optional standalone skip and zero failures; the actual standalone
was separately exercised on the remote host. Binding lifecycle passed its real
broker/ExtensionRunner integration case. Routing passed 65 cases, including refusal
to fall back to another pane when the selected native surface is unavailable.

Authorized foreground inspection subsequently confirmed a native ID round-trip defect
on the screenshot's actual remote conversation. `cx.session:focused()` returned an
opaque numeric ID; passing that same value to `pane` and `surface` returned nil.
In the same context, `pane('@focused')` returned the live agent and
`surface('@focused')` returned the `omp.session` inline surface. This is no longer
an inference from a hidden pane. Observed builds are GUI/CLI 0.9.5 and remote host
0.8.3; aligning versions alone has not been shown to fix the native lookup.
The temporary probe was removed, and private metadata evidence is retained under
`.scratch/bridge-pane-probe/focused.json`. No OMP input was sent or session restarted.
The user navigated back to another local session during inspection; that choice was
left untouched and desktop control was released. The existing numeric-ID path remains
affected. The Bridge plugin does not decode IDs, guess another target or weaken
transport checks; alternative native interfaces were subsequently exercised below.

The user confirmed the installed application is already the latest available version.
Release-login investigation was stopped; no upgrade or daemon-state reset was performed.
Upstream [issue #30](https://github.com/stencil-hq/tern-sdk/issues/30) reports the same
ID round-trip failure, including observations on 0.9.5. A full-ID CLI replacement is
not a verified end-to-end repair: the window plugin and its child process exposed
no `TERN_WINDOW_KEY`, and [issue #131](https://github.com/stencil-hq/tern-sdk/issues/131)
documents missing caller-window targeting. The metadata-only context probe result is
retained at `.scratch/bridge-window-context-probe/result.json`; its installed plugin
and plugin-data directory were removed. No pane input or navigation was performed
by that probe. Inspection had not established a replacement for the complete layout,
snapshot-event, close and pinned-input path. That was not proof that all plugin-only
workarounds require a native Tern patch.

Subsequent isolated experiments used Tern 0.9.5 and actual OMP 18.12.5-1.1.66:
- `new_block(..., "beside", {focus=false})` opened a plugin block without a numeric
  target lookup and preserved focus.
- An exact full-decimal string passed to `session:event` addressed a remote loopback
  block after switching to another host. Host `tern.pane.write` used the receiver's
  authoritative `TERN_PANE`; ESC, BEL and UTF-8 bytes arrived unchanged at that PID.
- An event requesting `BlockCx:exit` removed only the owned block; the original
  receiver remained live and the other host's focus was preserved.
- A factory `setWidget` component exposed a dedicated native role through `describe`
  and received an action through `handleNativeEvent`. The exact control value arrived
  after a host switch; the synthetic unsent draft was unchanged and submissions were
  zero. The editor was not replaced. This is not the raw `onTerminalInput` path.

Evidence and the throwaway fixture are under `.scratch/api-bypass-probe-knJMBR/`,
including `result.json`, `widget-native-node.json`, `widget-event.json`, the per-PID
byte receipt, and `shots/serve/native-widget-control.png`. The isolated service was
stopped and no matching probe processes remained. No existing OMP session was changed.
These were API feasibility results, not a deployed Bridge repair. The subsequent
0.4.0 implementation replaces pane input with a structured widget locator and an
authenticated, draft-owned broker channel. Its native acceptance gate remains open.

### 0.4.0 native transport acceptance gate

The isolated high-counter loopback fixture reproduced failed numeric pane lookup
while the actual OMP widget remained discoverable through the focused surface.
The subsequent authorized desktop fixture opened and closed the host-rendered panel
and retained its connected state across repeated observations. High-counter desktop,
multi-window and stale-target acceptance remain separate; do not deploy on these
results alone.

The latest headless probe received HTTP 200 for `/v1/state`, but its queued native
dispatch never ran. A separate plugin registered 0/1/50/100 ms timers from a command;
none was observed firing after synthetic clock advancement and real elapsed time.
Retaining a timer handle did not change the result. This does not establish a timer
defect in normal desktop windows. Moving the receipt pump to a periodic load-time
timer did not resolve the observation and that speculative change was reverted.

Private evidence is under `.scratch/native-transport-EAL866/`: `queue-evidence.json`,
`native-timings.json` and the isolated renderer logs. The initially unanswered desktop
approval was subsequently granted. No existing OMP session was restarted, and this
revision was not deployed.

After reverting the speculative pump change, `bun run typecheck` passed. The five
targeted draft, native-editor, binding-lifecycle, broker-routing and client-service
test files passed 77 tests with zero failures (706 assertions); the local-UI tool
mutation case was excluded. The shipped Luau routing harness passed 67 cases and
the host-panel harness passed nine. These are contract/synthetic-boundary checks,
not desktop clipboard or multi-window acceptance. The isolated renderer, clock
driver and broker/client services were stopped; diagnostic evidence was retained.

Authorized desktop evidence (Tern native window, OMP 18.12.6-1.1.66) is retained in
the private fixture `/private/tmp/tog-zCBlg0`. The user completed Stencil login.
The fixture's separate broker/client roots required correcting `serverControlFile`
to the broker directory; the fixture launcher now writes that explicit mapping.
The widget opened a connected sidebar; Hide Bridge removed only its owned block
and preserved the synthetic unsent draft. Reopening succeeded.

The user selected `package.json` through the native upload picker. Client state
reported `attached`, with 1258/1258 bytes transferred, and the received file's byte
count was independently checked. The actual OMP core-editor observation and desktop
AX/screenshot showed its quoted import path appended to the original synthetic
draft, followed by receiving-inbox guidance. Both submitted-input counters remained
zero. The client remained connected; the sidebar was absent at the final inspection.
Its disappearance during the picker flow is not yet attributed or accepted as
intended behavior. This verifies one native ordinary-file attachment, not image,
clipboard, physical-SSH, multi-window or stale-conversation delivery.

A later desktop run reproduced the sidebar disappearing after opening it and
waiting 18 seconds without another action, beyond the broker's 15-second lease.
This is a failing lifecycle acceptance result, not successful heartbeat proof.
Temporary in-memory phase probes also observed stalled queue progress; the native
log recorded `timer exceeded 50 ms` during diagnostic reloads. Those observations
do not yet identify the original expiry's cause. The workstation then locked,
preventing further keyboard/AX verification. Diagnostic plugin edits were removed
by restoring the shipped window script, control was released, and the fixture's
existing draft and uploaded file were retained. No production deployment occurred.

After unlocking, retained timer handles did not prevent the sidebar expiry. A
window-owned periodic receipt-pump experiment also did not pass native opening;
both experiments were confined to the fixture and reverted. An independent
command registered 0/1/50/100 ms one-shot timers and observed all four firing, so
the evidence does not support a blanket claim that desktop timers are broken.
Further timer-chain probes were inconclusive: their diagnostic save commands
themselves exceeded the native 50 ms hook budget. A second isolated window was
created, but multi-window routing acceptance was not completed. The task-scoped
desktop grant subsequently became inactive and renewal was unanswered. Temporary
observer probes were removed; the isolated windows and original draft were retained.

## Setup selection and session lifecycle repair

Explicit selection of a server with a canonical or remembered address now starts
one bounded, read-only SSH check. Manual/unmapped selections require input.
Opening or refreshing does not repeat successful checks or installation.

Setup and ordinary Bridge views relocate to the caller's current session/tab;
only the previous owned display closes. Old view generations, queued publishing
and consent callbacks cannot act on the new view. In-flight operations retain
their approved target and receipts. Verified installation remains verified while
local endpoint metadata becomes available; host-plugin and service-upgrade gates
remain distinct from the remote OMP extension handshake.

Native logs identified 50 ms load/timer budget failures. The window no longer
loads the setup dependency chain in its load hook. Config read, endpoint read,
fetch startup and setup view operations are staged across separate callbacks.
Fixed 20-cell shrinking was removed from both displays after a native small-window
check showed it reduced the setup content to 183 px; the same viewport now retains
351 px of content using the native split.

Verification:
- Pre-fix regression reproduced `focused stale setup pane`; repaired coordinator
  passed 37 scenarios. Window routing passed 64, renderer 22 and host panel 12.
- Typecheck passed; setup UI and packaging suites passed 33 tests, zero failures,
  with 467 assertions. The unrelated full native-runtime suite was not rerun.
- Actual Tern session/layout APIs closed pane 8 and opened pane 13 in the second
  session while preserving caller focus 11. Closing that display and reopening in
  a third session created pane 18 while preserving focus 16. Native assertions
  confirmed the current session and absence of the previous setup panes.
- The isolated native driver used the shipped coordinator with real native
  contexts and manually advanced timer receipts, because headless `serve` does not
  deliver those window timers in this environment. This proves native pane/session
  operations, not a complete real remote installation or autonomous timer delivery.
- Native screenshots and the isolated driver are in `.scratch/setup-session-LzCxrX/`.

## Setup visual hierarchy revision

The setup view now has a compact native header, one target summary, a disclosed
host picker and a single primary action per stage. Manual choices are explicitly
marked by the controller, deduplicated by the view and retain their numeric route
key. Local Change/Cancel/Edit/Details actions do not authorize host operations.
Input identity remains `main.ssh`; stale and busy views cannot change selection,
edit, retry or install. Failed SSH checks say setup needs attention, not that an
installation ran and failed. Theme styling is scoped to the two setup surfaces.

Native verification used Tern's actual offscreen renderer, not a browser mock:
- Captured connection, host-picker, review, failure, inline edit, checking,
  installation, awaiting-session and ready surfaces.
- Inspected light and dark themes, with 471 px and 311 px content widths.
- Real native clicks opened the host picker (one manual option) and revealed the
  failure state's SSH editor without changing the selected target.
- Final phase screenshots are under `.scratch/setup-design-b17hwr/shots/serve/`.
- 20 setup-renderer, 20 coordinator, 52 routing and 12 host-panel cases passed.
- Typecheck and build passed. The broad Bun run finished with 176 passing tests,
  one platform skip and two failures in `client-service.test.ts`: native worker
  bootstrap exceeded its 30-second deadline; one teardown also timed out. This
  run is not a clean full-suite pass. No timeout was raised or failure suppressed.
- The redesigned package was installed into the main Tern directory and reloaded;
  native catalog reported host/window ready with no plugin problems.

These controlled snapshots verify rendering and local interactions, not a real
installation outcome. Desktop control approval timed out; no installation consent
was submitted and no existing OMP session was restarted.

## Native setup sidebar (0.3.0)

Setup uses a persistent native block. Process callbacks retain receipts only;
subsequent timer stages validate results and update the view. Initial snapshots
wait for the host surface to exist. Installation remains a separate affirmative
action after SSH verification; existing OMP sessions are not restarted.

The small display-only remote package uses the existing Tern connection, not
SSH. Its owned preparation terminal stays open for completion capture. Native
testing exposed a 50 ms budget failure with a single large input operation;
the controller now sends at most 512 payload bytes per timer stage.

Observed verification:
- 20 coordinator, 14 setup-renderer, 52 window-routing and 12 host-panel cases
  passed against the shipped Luau modules.
- Typecheck and build passed. The source-only Bun run passed 178 tests with
  one platform skip, zero failures and 1,891 assertions across 25 files.
  An earlier unqualified test filter also selected stale `dist/` test copies;
  the final run explicitly targeted `./tests` and the two source script suites.
- The actual generated package command ran through an isolated native Tern
  terminal in bounded chunks and returned the exact nonce-bearing READY marker.
  This installed only the display package into an isolated local configuration.
- Headless `serve` rendered the native form but did not deliver window-plugin
  timer callbacks in this fixture. It does not prove the full controller flow.
- Ordinary desktop control approval timed out. Real-window confirmation-to-
  completion, actual remote UI deployment and Windows remain unverified.

## Connected-host selection and SSH preflight (0.2.1)

Setup now lists connected remote hosts with the current session's host first,
uses connection addresses rather than display names, and preserves an explicit
manual SSH option. Opaque relay/device addresses require a user-supplied mapping.
Mappings are stored by exact connection address in native plugin storage only
after installation consent. Host switching cannot retarget an in-flight flow;
replacement/disconnection of the selected host invalidates it.

Observed verification:
- The shipped helper passed 432 assertions and nine executable local POSIX probe
  cases. The runner invokes the public argv builder, including remote-shell quoting.
- The exact shipped SSH argv and result classifier were exercised against a real
  Linux host and an intentionally invalid DNS name: success reported Linux/x86-64,
  and failure was classified as network-related. No remote installation or writes
  were performed by these probes; the throwaway smoke script was removed.
- The shipped window router passed 95 SDK-boundary scenarios; the host panel passed
  12. Coverage includes cancellation, duplicate guards, explicit retry, exact-address
  mapping isolation, target replacement, and current-host changes during selection.
- Typecheck/build passed. The full Bun suite passed 181 tests with one platform
  skip and zero failures (1,956 assertions across 25 files).
- Main Tern loaded 0.2.1 with both host/window entries ready and no plugin problems;
  a fresh screenshot and accessibility tree confirmed the setup entry remains visible.
  The native picker-click attempt was blocked by UserIntervened while the user was
  operating Tern; no input was sent and no installation consent was submitted.
  Native picker/confirmation interaction and Windows desktop acceptance remain unverified.

## Unified plugin initialization (0.2.0)

The plugin now exposes an explicit, consented **Set up Bridge** workflow rather
than treating copied display files as a completed installation. New identities
have no agent capabilities. Existing sessions, identities, grants, bindings and
unrelated configuration are retained.

Observed acceptance:
- With global Bun excluded from PATH, the Unix launcher downloaded and verified
  a private Bun 1.4.3 runtime. Full bootstrap reached the trusted-SSH preflight;
  an intentionally invalid host produced bounded, recoverable failure state.
- A real macOS-to-Linux SSH initialization installed into isolated directories,
  started the broker/client, and verified signed registration. A repeated run
  reused both service PIDs and the same client identity. The client remained
  connected after initializer exit, retained unrelated configuration, and had
  an empty capability grant.
- No OMP view existed in that isolated run, and its Tern directory intentionally
  did not identify a live daemon. The result remained `awaiting_session`, not
  `ready`; no production conversation or binding was changed.
- Cross-platform execution exposed AppleDouble metadata added by macOS tar.
  Archive creation now excludes that metadata instead of weakening integrity
  verification. The regression failed before the fix and passed afterward;
  the original real-SSH setup then succeeded.
- The shipped window router passed 59 synthetic SDK-boundary cases and the host
  panel passed 12. Host-plugin reload and service-upgrade attention remain visible
  even when an OMP view already exists; connectivity cannot erase those gates.
- Managed shutdown joins the native SDK cleanup registry instead of racing its
  signal-triggered hard exit. Real macOS client and Linux broker checks confirmed
  endpoint, ownership and lock removal after authenticated SIGTERM. Restart from
  stale records also preserved the existing client identity.
- Final integrated verification passed typecheck, build, and 170 Bun tests
  (one platform skip, zero failures; 1,736 assertions across 25 test files).
- Main Tern loaded version 0.2.0 with both host/window entries ready and no plugin
  problems. A fresh screenshot and accessibility tree confirmed the right-aligned
  **Set up Bridge** control. This does not establish setup confirmation-to-completion.

Native setup confirmation-to-completion GUI acceptance and real Windows setup
remain unverified. Desktop control approval was not obtained for this check;
no native initialization consent was submitted on the user's behalf.

## Right-side native Bridge Block

Implemented a real `omp-client-bridge.panel` host Block with a window-status
toggle, public device/target/transfer display, and window-routed actions. It is
not Canvas. Closing its UI does not cancel transfers. Snapshots omit credentials
and clipboard payloads; a 5-second owner heartbeat expires after 15 seconds
(the host timer observes expiry within 15–20 seconds).

Visual correction: the initial host view incorrectly relied on bare surface
defaults. Tern documents that regions inherit the terminal monospace font and
plain `el` buttons are reset to unstyled text. The panel now ships a stylesheet
scoped to `plugin.omp-client-bridge.panel`, using `--sans`, native control radii,
theme text/fill/hairline tokens, bounded control padding and hover/focus states.
The title and connection badge share a header row; section bodies no longer use
tree-like indents, and the redundant action hint was removed. No transfer or
approval contract changed. Twelve host-panel regressions and build passed;
the real isolated installer/catalog recognized the stylesheet and ready plugin.
After renewed permission, the stylesheet and host view were deployed only to the
isolated acceptance configuration. Fresh screenshots in horizontal-tab and Rail
layouts confirmed sans typography, a compact header badge, bordered rounded
buttons, unindented sections and the footer control. The neighboring terminal
retained its monospace typography. The observed panel was disconnected: enabled
and hover states, dark appearance and an explicit floating-margin setting were
not validated. Existing unrelated notifications obscured part of the upper panel
and were left untouched. Desktop control was released after inspection.

The user rejected that first styled composition as still visually unsuitable.
A subsequent composition revision removed repeated full-width controls, moved
Hide into the header, paired paste/upload, collapsed device details, and hid
zero-approval/unknown-placeholder sections. The disconnected state now contains
only its header and a connection explanation. A fresh read-only Rail screenshot
confirmed that empty state in the real isolated window. A later real connected
Rail inspection also verified the paired controls, collapsed/expanded device
details, and empty transfer list, alongside Tern's native Files sidebar. The
inspection replaced the debug pane ID label with its title/folder and reduced
vertical gaps. No clipboard read, upload or prompt submission was performed.
Hover/dark appearance and user aesthetic acceptance remain separate. Twelve host
behavior cases passed; a duplicate device-row/section key found by the harness
was corrected before packaging.

The next revision studied the rendered official Tern website's product demos,
not just its hero or extracted text; findings are in
[Tern design reference](research/tern-design-reference.md). It introduces a
workspace context card, native icons/item rows, compact state badges, and grouped
transfer progress. The 12 host-panel behavior cases and package build passed.
Installation into the isolated acceptance host reported ready with no problems.
After the user unlocked the Mac, the isolated SSH agent and stalled native remote
transport were restored with the existing endpoint identity. Fresh screenshots
confirmed the redesigned panel in the real connected Rail window at approximately
444 and 300 logical pixels wide (2x capture). The workspace card, source-device
row, paired actions, status badge and empty transfer section fit at both widths.
The narrow screenshot is `omp-computer-15adb707d52bc4a5.png`; the detail capture is
`omp-computer-15adb71c5f2bc4a6.png` in the desktop tool's temporary capture directory.
This is visual evidence, not complete functional acceptance: agent resolution
remained `Resolving` and a `timeout: global` toast appeared. Device-list expansion,
active transfer states, dark appearance and user aesthetic approval remain unverified.
No clipboard read, file upload or prompt submission was performed in this review.

The interaction follow-up restored the real services and reproduced an enabled
upload control rejecting an expired destination. A failing regression confirmed
that the click refreshed identity but never opened its prompt. Chooser preparation
now waits for matching identity and opens once; replacement conversations/drafts
remain rejected, and drop/capture validation is unchanged. The shipped router
passed 54 cases, the host panel passed 12, and the package build passed.
Real native verification opened and cancelled the upload prompt, paste source
picker and agent-device picker; expanded available devices; and exercised empty
transfer-history feedback. No clipboard was read, no file uploaded, and no binding
changed. Screenshots confirmed hover highlighting and the compact sans Bridge
status chip without the former debug-style sentence or duplicate paste shortcut.
Some scripted AX waits timed out before subsequent fresh captures showed the
requested chooser, so these checks do not establish a response-latency bound.
The isolated acceptance services are retained for the user's interactive review.

The file-chooser follow-up right-aligns the status plugin group using its native
flex layout; a fresh Tern screenshot confirmed the Bridge control at the right
edge. Upload now calls an authenticated local-human endpoint instead of asking
for a typed path. The actual macOS NSOpenPanel was captured both from the helper
and through that client endpoint; aborting the HTTP request closed the dialog,
with no file selected or uploaded. Typecheck/build passed, as did 48 routing and
12 host-panel cases after removing obsolete manual-path cases. Windows/Linux
dialog execution and a complete selected-file upload through the new chooser
remain unverified. The final Bridge-click visual check did not observe a dialog;
subsequent desktop capture timed out and the computer worker reset. This does
not establish that the native button-to-dialog path passed GUI acceptance.
The final full Bun suite passed 139 tests with one platform skip and no failures.
The retained review SSH broker subsequently exited 255 with `Broken pipe`;
the native transport also exited 255. This connection loss blocks the remaining
button-to-dialog GUI acceptance and is not evidence that an upload succeeded.

The informative-status revision replaces the generic Bridge label with the
client/broker connection and selected agent-device state, while retaining right
alignment. A regression checks the selected device rather than another listed
device, preserves that identity when the panel gains focus, warns for an offline
device, and removes stale device identity after disconnection. All 49 routing
cases and the package build passed. The actual Tern window displayed
`Connected · No session` after reload: its client link was online but its native
remote panes were unavailable. Bound/offline variants were exercised in the
shipped-code harness, not simulated as live GUI state. Tern's existing load/status
budget failures were observed during installation; a native reload restored the
formatter. No connection recovery or upload acceptance is claimed by this check.

Transfer status now distinguishes preparation, byte-weighted upload progress,
handoff, unknown/offline status, failure and a five-second completed-handoff
indicator. Shipped-code regression scenarios cover weighted totals, unknown
sizes, offline display, phase changes, completion expiry and historical replay.
The existing `plugin.omp-client-bridge.paste-remote` command was confirmed in the
real native palette under OMP; no user shortcut was changed. The live acceptance
host remained disconnected, so the progress scenarios are harness evidence,
not a new live file-upload acceptance result.
All 51 routing scenarios and the build passed for this revision. The native
palette visibly listed OMP → Paste to remote. The acceptance window subsequently
closed; no other Tern window or user keybinding was modified.


Verification: typecheck and build passed; the Bun suite passed 139 cases with
1 Windows-only skip and no failures. The shipped window router passed 52 Luau
cases; the shipped host panel passed 12. An isolated real installer invocation
followed by Tern 0.9.5 `plugin list --json` reported both host/window entries,
the hidden-from-palette `panel` block, `status: ready`, and no problems.
This catalog smoke is not a rendered-panel or native click-routing proof.

Integration corrected a native identity mismatch: the block kind is
`omp-client-bridge.panel`, while its surface role is
`plugin.omp-client-bridge.panel`. Using the real role made the original router
regression fail before the correction and pass afterward. An empty target-filtered
transfer list now avoids opening an invalid empty picker.

After renewed explicit desktop permission, the real isolated macOS window opened
the right-side native Bridge Block, received a Connected snapshot, and displayed
its target/source/device controls. Native panel hide and status-bar reopen worked.
The Upload file button opened Tern's native path prompt; a 218-byte synthetic
ordinary file reached the original Linux OMP draft as a quoted remote path with
the archival reminder. Source and received SHA-256 values matched.

The unified clipboard entry and its local approval picker also delivered
multiline Unicode text. The real remote editor observer retained the file path,
reminder and exact text/newline, with idle=true, pending=false and zero submitted
inputs. Panel focus did not retarget these operations.

Acceptance is still partial. A fetch callback exceeded Tern's 50 ms limit and
disabled the hook until reload; the owner heartbeat subsequently expired as
designed. Reload recovered the successful operations above, but this is not a
stability fix. Some background clicks and AX actions did not produce the expected
prompt; the successful fresh-panel AX action was observed directly. Temporary
route diagnostics were removed afterward.

The screen then locked, preventing further desktop inspection/input. Rail with
floating margins and image paste through this new panel remain unverified. Desktop
control was released and the owned broker/client were stopped; the isolated GUI
and referenced files were retained. No unrelated user sessions were modified.


## Unified paste and layout follow-up

The unified clipboard/file implementation passed typecheck, build, and the full
Bun suite: 139 passed, 1 Windows-only skip, 0 failures across 21 files. The shipped
Luau router passed 39 synthetic SDK-boundary cases with official Luau 0.743.
Its archive SHA-256 matched the official release asset. An initial routing run
failed because the previous temporary interpreter had been removed; this was
not a router assertion failure.

The native GUI remains unverified for this revision: desktop-control confirmation
timed out and the host reported a locked screen. Earlier successful image-only
GUI evidence below is not a pass for the unified entry or multiline text route.

After considering Rail and floating margins, the user approved a compact window
status summary/toggle plus a narrow right-side native plugin Block. Canvas stays
excluded. This composes existing status, host-block and layout APIs; it does not
claim a new Tab-bar button slot or inject controls into the OMP editor. Existing
split trees are preserved rather than rebuilt to simulate a full-height sidebar.
Fresh installed Tern 0.9.5 declarations remain the interface reference.

Files-directory drag upload is exploratory only. Official file-routing and
Files documentation do not establish local-to-remote-directory upload semantics;
the actual gesture was not attempted while locked. No Files upload feature was
added and no unsupported verdict was inferred. Ordinary-file paths alone carry
the archival reminder; image-only attachments do not add path/reminder prose.

Sources: [Chrome](https://docs.stencil.so/tern/guides/chrome.md),
[Window API](https://docs.stencil.so/tern/reference/api-window.md),
[Files](https://docs.stencil.so/tern/scripts/files.html),
[routing](https://docs.stencil.so/tern/guides/routing.md).


## Automated checks for this change

Review baseline: `026c4389005689e5f847996a25220d88acf54fcc`. Checks used Bun 1.4.3
on macOS arm64 and the pinned OMP SDK 18.10.4.

| Check | Observed result |
|---|---|
| `bun run typecheck` | Passed |
| Targeted image/inbox regressions | 59 passed across five files |
| `bun run test` | 136 passed, 1 skipped, 0 failed; 137 tests across 21 files |
| `bun run build` and built CLI `--help` | Passed |
| Shipped Luau routing harness | 16 cases passed |

The skipped case is Windows-only private-storage ACL coverage. It is not a
Windows pass. The first full run found an obsolete test asserting image rejection;
that test now checks real-broker PNG transfer, native format preservation and
unchanged source bytes. No production error was suppressed to satisfy it.

The native-editor regressions use the actual `ExtensionUiController`,
`InputController` and `CustomEditor`, not a pasted-image callback echo. They check
PNG payloads, mixed image/ordinary batches, preserved existing text/images, and
no automatic submission. Other cases cover approval/no-read denial, rejection of
programmatic approval flags, disconnect/late read cancellation, immutable
snapshots and claim ownership, README publication/permissions/cleanup, and the
existing upload-admission and queued-Eval cancellation repairs.

## Real remote interactive smoke

A Mac client with no agent-execution capabilities connected through real outbound
SSH to an isolated Linux broker and the installed interactive OMP 18.12.3.
The actual extension and native editor were used, not RPC mode or a replacement
frontend. Synthetic PNG and ordinary files exercised the selected-file upload
path while the session remained unbound.

Observed result: **passed**, with no cleanup errors.

- Image-only transfer produced a native image chip without ordinary-file prose.
- A mixed transfer retained the existing image and text, added the ordinary
  file's remote path and archival reminder, and produced a second native chip.
- All remote file SHA-256 values matched the source bytes; source files remained
  unchanged. The published README contained the archival/workspace warning.
- The native composer retained the originating conversation, remained idle and
  unsent, and contained both image chips and the ordinary-file reminder.
- The owned OMP, client, relay and broker were shut down.

This proves real SSH transfer and native unsent-draft handoff. It does not prove
an OS mouse-drag gesture, a physical clipboard read, or Windows GUI behavior.
The native-image payload checks belong to the separate actual-controller
regressions above; the CLI smoke observes native composer chips and verified files.

An earlier probe reached the same image/inbox observations but failed an extra
submission-event check. That probe was removed from the unsent-draft smoke rather
than requiring model submission to validate a feature that must not submit.
A subsequent attempt timed out starting its isolated broker; process/metadata
inspection found no surviving fixture broker and a direct CLI load succeeded.
The clean retry passed. These failed probes are not counted as successful runs.

## Desktop evidence boundary

After restarting OMP, built-in computer-use recovered. On 2026-10-20, a
real macOS Tern 0.9.5 window connected to an isolated Linux OMP 18.12.3
session. The human authorized synthetic clipboard and file-drop acceptance.

The explicit **Paste image to remote** action opened the local approval picker.
Approving **Read image once and upload** transferred 1,674 bytes and displayed
**Handed to OMP**. The actual native composer rendered a colored thumbnail,
image chip **#1**, and **356x200** dimensions while retaining the existing draft.
The remote observer confirmed the same conversation, idle state and zero
submitted/intercepted inputs. The received inbox contained `0-clipboard.png`
and a README requiring archival before work and preserving referenced files.

Earlier attempts encountered Tern's 50 ms plugin-hook limit, disabling timer
or fetch callbacks until reload. Scoped diagnostics and reload recovered this
clipboard run; no production timeout fix or general reliability claim follows.
Temporary diagnostic statements were removed afterward.

OS file dragging remains unverified: built-in foreground activation did not
reliably expose the isolated destination, and fresh focus checks instead named
another user conversation. No drag was attempted into that conversation. This
tool limitation was reported; no alternate desktop controller was used.
Ordinary-file path/reminder evidence remains the earlier SSH smoke above, not
a new mouse-drag pass. The owned remote OMP exited with code 0.
The tracked client, broker, SSH agent and native-server transport were stopped.
Closing the isolated GUI was refused with `UserIntervened`; the user-touched
window and its staged files were therefore preserved, and desktop control was
released. The referenced inbox was not automatically deleted.
Remote process inspection still found the private native listener and session
daemon. They were retained with the user-touched GUI, not counted as cleaned up;
stopping the SSH transport did not terminate these native processes.

## Standards

Independent review found no remaining actionable defects under the clarified
contract. Earlier concerns that required new native dequeue/focus interception
were withdrawn: those semantics are deliberately delegated to native OMP.
Approval, cancellation, capture ownership, finite HTTP deadlines and atomic
inbox publication had no remaining evidence-backed findings. The visible
terminal label is **Handed to OMP**, not a claim of rendered preview completion.

## Spec

Independent review found the requested explicit image entry, image handoff,
ordinary-file inbox and archival reminders implemented. Native paste remains
unintercepted, and no agent clipboard tool or watcher was added. No remaining
source-backed Spec blocker was identified for this clarified change.

Outstanding evidence is explicitly separate: actual OS file-drag gestures,
cross-pane and IME/streaming behavior, native Windows/mixed physical clients,
remote browser and authorized Android-device acceptance. Those broader gates
are not waived or marked passed by this change.

## Earlier verified baseline

Before this change, three independent client identities on one Mac were exercised
against a real Linux broker: shared binding/actor convergence, in-flight target
capture, retained contexts, native file/shell operations, and a 1,048,593-byte
unbound transfer with matching digest. Separate bounded macOS browser/desktop
checks are described in [Compatibility](compatibility.md). Those results are not
new cross-platform claims for this image/inbox change.
