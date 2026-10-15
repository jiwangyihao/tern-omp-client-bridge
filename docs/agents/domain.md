# Domain documents

This repository has one domain context.

- [CONTEXT.md](../../CONTEXT.md) is the glossary: canonical names, meanings, and
  relationships. It is not an implementation plan or a scratchpad.
- [docs/adr/](../adr/) records consequential decisions and the reasons behind
  genuine trade-offs.

Before changing behavior, use the glossary and read related ADRs. State a conflict
with an accepted decision instead of silently replacing it. If a document is
absent, continue with available evidence; create documents lazily when a resolved
term or qualifying decision gives them content.

Keep terms short and domain-specific. Put implementation choices and acceptance
criteria in the specification or implementation ticket, not in CONTEXT.md.
