---
status: accepted
---

# Keep human transfers independent of the agent binding

Human paste and drag/drop take content from the Tern client where the person acts
and place it in the intended remote OMP draft. They work even when the agent
session is unbound or bound to another client, because selecting an execution
target is not selecting the person's clipboard or dropped files.

Transfers retain the destination draft and do not submit it automatically.
Standard Cmd/Ctrl+V remains a product requirement: a dedicated command may help
implementation or diagnosis, but is not an agreed replacement for native paste.

This project adds no agent clipboard-reading feature or automatic clipboard
synchronization. It also does not introduce a special clipboard sandbox for code
that the person has separately authorized to run through Bash or Eval.
