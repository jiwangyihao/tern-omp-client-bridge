# Tern visual reference for Bridge

Reference: https://stencil.so/tern — inspected as a rendered interactive page, not only extracted text.

## Full-site second pass

Reviewed at **1920×1440**, with scene navigation allowed to settle before capture. Covered the hero, Daemon, Everywhere, Graphics, Files, Blocks, Script, Speed, Yours, and the closing access section at [the official site](https://stencil.so/tern). Original-resolution captures were used for details; the transcript's scaled thumbnails are not a basis for measuring controls.

- [Daemon](https://stencil.so/tern#daemon): one connection object, with an icon/name identity, quiet technical subtitle, small trailing status, and compact related rows. The host picker uses a selected row, not a large form hierarchy.
- [Everywhere](https://stencil.so/tern#everywhere): browser, desktop and phone preserve the same workspace structure. Small client identity captions and connection lines explain ownership without turning the content into controls.
- [Graphics](https://stencil.so/tern#graphics): content blocks carry their own hierarchy—diagram, formula, diff and web output. Tool/status information remains subordinate; the frame is not the content.
- [Files](https://stencil.so/tern#files): document headings belong to the document; pane headers, view switches, path metadata and media controls are much quieter. A tool panel should not borrow the document's heading scale.
- [Blocks](https://stencil.so/tern#blocks): inspected Git, SQLite, notebook, board, task manager and screen-sharing panes. Consistent aligned headers and small local actions support very different content densities. This does not imply that unrelated actions should become joined buttons.
- [Script](https://stencil.so/tern#script): separate command, event and output surfaces retain stable boundaries; animation demonstrates the relationship rather than replacing static hierarchy.
- [Speed](https://stencil.so/tern#speed): large numerals are reserved for the subject being measured. Supporting units, state and timeline annotations are quiet; this is not a template for a connection-status heading.
- [Yours](https://stencil.so/tern#yours): observed all four layout states, **Tiles, Studio, Rail and Float**, plus theme-picker and prompt-style demonstrations. Layout changes containment; control identity and selection cues remain consistent.
- Hero and access: large gradient typography, atmospheric particles and the brand CTA are presentation-page devices, not appropriate defaults for an operational Bridge panel.

The user rejected the experiment using a horizontal settings row, quiet select, joined transfer buttons and `{34,12}` sizing. That experiment was reverted to the preceding panel, including the full-width inline field, separate actions and `{32,13}` size hint. Do not describe the rejected version as an accepted improvement.

**Design correction:** compactness is not the goal by itself. Preserve clear controls and the accepted interaction. Refine the identity/status/metadata hierarchy and surface proportions as a coherent whole; do not equate using a native component variant with achieving the website's visual quality. A new visual direction needs user review before another live replacement.

The user subsequently approved the read-only connection-card prototype and requested
its implementation, including hover/state motion. The implemented hierarchy keeps
the full-width field and separate actions, uses a host identity tile and quiet
status, and separates workspace context from human-transfer and agent-target data.
The first native pass exposed doubled pane/body insets and a clipped footer; those
were corrected using the native grid-padding metrics and verified in the actual
window. The browser prototype is a visual reference, not evidence of native behavior;
native motion and reduced-motion evidence is recorded in `../verification.md`.

## Observations

- **Hero versus product:** the hero uses oversized editorial type, teal/violet gradients and particle motion. These advertise the product; they are not appropriate backgrounds or typography for an operational sidebar.
- **Daemon:** host identity is an icon tile plus a primary name and a quieter technical subtitle. Connection state is small and aligned at the trailing edge. Client rows use a faint fill, compact padding and a short state capsule, not a stack of full-width action buttons.
- **Blocks:** Git, database, notebook and process views put controls next to the data they affect. Thin separators, compact toolbars and restrained color carry the hierarchy. Small icons distinguish object types; long prose labels do not substitute for icons.
- **Files:** document/code content remains the focal point. Toolbars are subordinate, with contextual actions and quiet metadata.
- **Yours:** Rail, Tiles and floating layouts change containment, not the identity of controls. Theme variation affects surfaces and color; the structure remains legible. The theme picker is a dense row list with subdued selection, not a gallery of large cards.

The website demos are authored web representations, not proof of the exact native implementation. Verified metrics from the Stencil Tern design guide (`https://docs.stencil.so/tern/guides/design.html`):
- **Typography:** 13px UI text (`font: "sans"` surface), 15px `title` token (one weight step up) for the head row only, 12.5px mono for machine values (`mono`, `num`, `path`, `code`, `key` tokens and tabular figures).
- **Density:** `md` controls (28px buttons/tabs) for chrome (head, bars, forms), `sm` controls (22px buttons, 18px badges) for content (rows, tables, detail cards).
- **Gaps:** `xs` 2px, `sm` 6px, `md` 10px, `lg` 16px.
- **Color/Status:** Meaningful semantic tones (`accent`, `info`, `pending`, `success`, `warning`, `error`, `muted`) applied to text, badges or 6px dots, not full-row color tints or hex overrides. Hairline separators instead of borders.
- **Primary Action:** Only one primary action on screen, targeting the selection; all other actions are default or `quiet` variants.
- **Input:** Forms use native `input` (or `field` with label/hint/error), `select`, and `switch` without custom container cards or heavy borders.

## Bridge design decisions

1. Native PiP frame owns the Bridge title and close action. The body shows a short remote-workspace label and trailing connection state, without repeating frame controls.
2. Destination: one icon-led workspace identity group with a quiet source-device line. Do not expose internal pane IDs.
3. Human actions: one compact shared action strip for paste and upload. Keep one primary action; do not make every action a bordered card.
4. Agent execution: native inline select field, separate from human transfers. A changed valid choice exposes **Use device**; opening or navigating the field cannot bind a device.
5. Devices: concise native option labels and quiet platform/availability details; no global picker or additional device-card stack.
6. Transfers: filename, phase and progress together when present; one quiet empty row and History action otherwise. No fabricated activity.
7. Empty/disconnected states: one meaningful explanation, not repeated Unknown labels or disabled control walls.
8. Use Tern theme tokens and shipped icons. Keep CSS inside the Bridge surface. No hero gradients, animation, global overrides, Canvas substitution or new UI-host API.

Native mapping: https://docs.stencil.so/tern/elements/lists.md (`item`), https://docs.stencil.so/tern/elements/data.md (`icon`, `badge`), https://docs.stencil.so/tern/styles/variables.md , https://docs.stencil.so/tern/elements/el.md . Plain `el` buttons need explicit scoped styling; standalone `item` rows provide the native label/detail/value hierarchy without creating a new selection protocol. Avoid verbose labels or disproportionate empty heights (e.g., repeating the Bridge title/close or using full-width action walls).
## Verification boundary

Compare the actual connected Bridge panel against Tern's native Files/settings in Rail, at a narrow width, before claiming completion. A screenshot of an empty state or the website itself is not evidence of the connected implementation. Aesthetic acceptance remains the user's decision.
