---
status: accepted
---

# Keep human transfers independent of the agent binding

Human paste and drag/drop take content from the Tern client where the person acts
and place it in the intended remote OMP draft. They work even when the agent
session is unbound or bound to another client, because selecting an execution
target is not selecting the person's clipboard or dropped files.

Bridge transfers retain the originating OMP context before handoff and do not
submit prompts automatically. After image handoff, native queue, focus and draft
semantics apply; the bridge does not impose an atomic post-handoff original-draft
guarantee or add rejection rules to native input.
Native rendering and ordinary paste semantics remain owned by OMP. The user requires
automatic image attachment at the native gesture, not a later conversion command.
A native `CustomEditor` subclass therefore routes recognized image-path payloads
from GUI `pasteText` and native edits into the existing image-paste pipeline. It
preserves native decoding, queued input and failure fallback, and is admitted only
when the existing composer has no draft or pending attachments. This supersedes the
earlier requirement to leave every native paste delivery path untouched.
The explicit **Paste to remote** entry still groups clipboard text/images and file
uploads. Native input does not require Bridge validation or an agent device binding.

This project adds no agent clipboard-reading feature or automatic clipboard
synchronization. It also does not introduce a special clipboard sandbox for code
that the person has separately authorized to run through Bash or Eval.

Images uploaded through the bridge are handed to OMP's native image-paste
handling. Ordinary files are received in a private temporary inbox and referenced
in the unsent draft. The directory explanation and draft reminder ask the agent
to copy/archive these files into appropriate durable project storage, report the
chosen location to the user, and work on those copies rather than in the inbox.
This agent-facing archival instruction applies only to ordinary files whose
paths enter the draft, not to images handed to native attachment handling.
The bridge does not choose an archive destination or automatically delete assets
still referenced by a draft or conversation.
