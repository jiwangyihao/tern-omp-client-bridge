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
Native paste remains unchanged. An explicit local image-paste command or button
is an approved supplemental entry, alongside file drops; it need not intercept
Cmd/Ctrl+V. Native input is not required to pass through bridge validation.

This project adds no agent clipboard-reading feature or automatic clipboard
synchronization. It also does not introduce a special clipboard sandbox for code
that the person has separately authorized to run through Bash or Eval.

Images uploaded through the bridge are handed to OMP's native image-paste
handling. Ordinary files are received in a private temporary inbox and referenced
in the unsent draft. The directory explanation and draft reminder ask the agent
to copy/archive these files into appropriate durable project storage, report the
chosen location to the user, and work on those copies rather than in the inbox.
The bridge does not choose an archive destination or automatically delete assets
still referenced by a draft or conversation.
