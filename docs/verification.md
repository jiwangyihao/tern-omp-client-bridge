# Verification record

## Acceptance status

**The complete specification is not accepted and Issue #1 must remain open.**
The implementation retains the native Tern/OMP GUI and uses existing tool names,
but native media paste and required real-platform acceptance are still incomplete.
The approved pure-plugin image-scope amendment requires rejection **before editor
mutation**; it does not waive native shortcut, ordinary-file, Windows, or
multi-client requirements.

Review baseline: `f68429d726a600b6f37f6eb7bd7d825209436834`. Both review axes included
new implementation files, not only the previously tracked diff. The checks below
cover the implementation containing the final upload-admission repair and shared
worker IPC schemas.

## Automated checks

Executed with Bun 1.4.3 on macOS arm64 and the pinned OMP SDK 18.10.4.

| Check | Observed result |
|---|---|
| `bun run typecheck` | Passed |
| `bun run test` | 119 passed, 1 skipped, 0 failed; 120 tests across 21 files |
| `bun run build` | Produced `dist/` with native worker and package metadata |
| `bun dist/src/cli.ts --help` | Built CLI started and displayed the documented commands |
| `bun tests/tern/run-routing.ts "$LUAU_BIN"` | 14 synthetic SDK-boundary cases passed against the shipped `window.luau` |
| Upload-initialization regression | Same-draft refresh and both replacement-destination cases passed |

The skipped case is the Windows-only private-storage ACL test. A macOS pass does
not establish Windows ACL behavior. The Luau harness controls SDK callbacks; it
is not a real clipboard, native editor, or cross-pane drag/drop test.

One preceding full run timed out after five seconds in the first binary-snapshot
case. The unchanged seven-test snapshot file then passed in isolation, followed
by the successful full run above. No timeout was increased and no failing case
was skipped. The cause of that earlier timeout was not identified; this record
does not claim a timing defect was fixed.

## Repairs and boundary evidence

- Queued Eval cancellation now acknowledges the cancelled waiting invocation
  without acquiring or cleaning up the running cell's owner. A native regression
  checks that unrelated background work and both retained language contexts
  survive, and that the cancelled mutation never runs.
- Capture cancellation removes completed but unclaimed private snapshots.
  Upload admission explicitly takes ownership, so a late capture-request abort
  cannot delete an active upload's files. Regressions check original-file
  preservation, concurrent live captures, cancellation and cleanup.
- Concurrent drops share an in-flight destination handshake rather than
  superseding each other. Each still retains its original destination checks.
- An admitted upload no longer depends on its resolve receipt remaining globally
  latest. A deterministic network/file-backed regression failed before the repair:
  refreshing the same conversation/draft during `upload.begin` rejected valid
  bytes. It now succeeds. Replacing the conversation or draft still rejects and
  cancels the remote partial. Receipt freshness remains mandatory at admission;
  the original connection, conversation and draft remain pinned afterward.
- Native text paste is no longer intercepted, classified asynchronously, gated on
  a bridge draft token, or replayed. The bridge has no pending text capture to
  deliver into a later conversation. Ordinary text remains separate from file
  attachment validation; no new native-session-switch warning is claimed.
- Programmatic clipboard capture is rejected at the source and authenticated
  HTTP boundaries. This is not a sandbox against separately authorized OS code.
- Earlier bounded checks demonstrated the browser idle-close repair on a real
  owned browser and the UTF-8 filename boundary repair on Linux. See
  [compatibility evidence](compatibility.md) for their exact limits.

## Real outbound SSH smoke

The final implementation also passed a real SSH smoke from macOS to an isolated
Linux broker, with three independently signed client identities and separate
outbound relay channels:

- All views began unbound; binding revisions and switch-actor state converged.
- An active native Eval remained on B while a switch selected C for the next
  invocation. Returning to B retained its kernel state and result provenance.
- Native file reads/writes and shell execution ran on the selected Mac client.
- An origin-A transfer while unbound published 1,048,593 bytes on Linux. The
  destination SHA-256 and byte count matched; the original source was unchanged.
- Owned clients, execution contexts, relays, forwarding and broker closed;
  cleanup reported no errors.

This exercised actual transport and native execution, not a model prompt or
native GUI file-paste gesture. All three clients still ran on one physical Mac;
it is not Windows or mixed physical-device acceptance.

## Native GUI observation

An isolated macOS Tern 0.9.0 window reached a private Linux Tern 0.8.3 endpoint.
The real Linux OMP 18.11.1 composer was visible, including distinct **This device**
and **Agent client: Unbound** controls. The actual extension observer reported an
idle empty core editor with the routed `eval` and `bash` tools loaded. Two
independent client services were connected.

This proves one native surface and its conversation handshake. The foreground
control confirmation timed out before the planned keyboard, clipboard and drop
checks; no alternate input mechanism was used to bypass that confirmation. No
model prompt was submitted. The owned OMP shut down with exit code 0; the test
window, clients, broker, temporary native listener and scoped SSH agent were
stopped. A scoped process inspection found no remaining remote GUI/listener
fixture processes. Existing shared remote services were not restarted.

## Standards

The independent Standards reviewer found no remaining evidence-backed actionable
defects after the repairs. Previous cancellation-isolation, abandoned-capture,
concurrent-drop and post-admission-refresh findings were resolved. Duplicate
execution/interaction validators were replaced by the shared schemas. This
source-review conclusion is not a platform or release-acceptance result.

## Spec

The independent Spec review remains **not accepted**:

| Open gate | Evidence and remaining requirement |
|---|---|
| P1: fail-closed human image attachment | The bridge's file-transfer path rejects recognized images, but native paste can bypass it. An earlier same-Mac native PNG paste inserted cache references instead of leaving the draft unchanged. A safe media-only hook is absent from the reviewed interfaces. Documentation does not waive this defect. |
| Standard file Cmd/Ctrl+V | Real transfer bytes alone do not prove native copied-file delivery into the intended remote unsent draft. No alternate shortcut or replacement frontend is accepted as a substitute. |
| Native drop destination and editing states | The drop request lacks an explicit hovered-pane identifier. The focused-pane implementation still needs real cross-pane evidence, plus selection/IME/streaming and destination-change checks. |
| Native Windows and mixed physical clients | Same-Mac client identities and source-level Windows coverage are not Windows GUI or three-physical-client acceptance. No such environment was exercised. |
| Browser routing across the remote bridge | Earlier real browser checks used two local macOS runtime contexts, not browser execution through SSH or Windows. |
| Authorized Android device | ADB discovery ran, but no authorized attached device was available for shell, logs, screenshot and file-transfer acceptance. |

Standards has no remaining actionable finding. Spec retains one confirmed P1
implementation omission plus the listed integration and environment gates. No
OMP/Tern host patch, clipboard watcher, forged approval, automatic side-effect
replay, or silent scope reduction was used to declare those gates complete.
