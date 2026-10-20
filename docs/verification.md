# Verification record

## Current approved scope

The user approved an explicit local image-paste entry and file drops. Native
text/image paste remains trusted and untouched: bypassing bridge validation is
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

Only OMP built-in computer-use is permitted for desktop verification. It failed
before any input because the running controller retained pi-natives 18.11.1 while
the installed loader was 18.12.1. Resetting the Eval kernel did not recover it;
the reported remedy is restarting the current OMP process, not reinstalling the
already-consistent files. No real system clipboard was read in these checks.
Actual click/approval/drag gestures and cross-pane targeting remain unverified.
The declared Tern window interfaces were inspected from installed Tern 0.9.5.

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

Outstanding evidence is explicitly separate: actual OS clipboard/drag gestures,
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
