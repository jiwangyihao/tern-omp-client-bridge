# Tern visual reference for Bridge

Reference: https://stencil.so/tern — inspected as a rendered interactive page, not only extracted text.

## Observations

- **Hero versus product:** the hero uses oversized editorial type, teal/violet gradients and particle motion. These advertise the product; they are not appropriate backgrounds or typography for an operational sidebar.
- **Daemon:** host identity is an icon tile plus a primary name and a quieter technical subtitle. Connection state is small and aligned at the trailing edge. Client rows use a faint fill, compact padding and a short state capsule, not a stack of full-width action buttons.
- **Blocks:** Git, database, notebook and process views put controls next to the data they affect. Thin separators, compact toolbars and restrained color carry the hierarchy. Small icons distinguish object types; long prose labels do not substitute for icons.
- **Files:** document/code content remains the focal point. Toolbars are subordinate, with contextual actions and quiet metadata.
- **Yours:** Rail, Tiles and floating layouts change containment, not the identity of controls. Theme variation affects surfaces and color; the structure remains legible. The theme picker is a dense row list with subdued selection, not a gallery of large cards.

The website demos are authored web representations, not proof of the exact native implementation. Source selectors: `.tn-dm-card-head`, `.tn-dm-client`, `.tn-dm-client-state`, `.tn-bk-bar`, `.tn-yr-chip`, `.tn-yr-pick-row` in https://stencil.so/_build/assets/tern-CnslWUJH.css . Measured rendered examples used Geist UI text, roughly 12–13px demo type, 6–10px row gaps/padding, restrained fills and no repeated large shadows.

## Bridge design decisions

1. Header: small plug icon, Bridge title, short connection state and close action. No huge heading or full-width status stripe.
2. Destination: one icon-led workspace identity group with a quiet source-device line. Do not expose internal pane IDs.
3. Human actions: one compact shared action strip for paste and upload. Keep one primary action; do not make every action a bordered card.
4. Agent execution: distinct selector row, separate from human transfer source/destination. Keep the existing window-owned selection/approval behavior.
5. Devices: native icon-led item rows, short trailing state; expandable details rather than repeated text stacks.
6. Transfers: filename/icon first, progress and byte count secondary, small history action in the section header. No fabricated activity.
7. Empty/disconnected states: one meaningful explanation, not repeated Unknown labels or disabled control walls.
8. Use Tern theme tokens and shipped icons. Keep CSS inside the Bridge surface. No hero gradients, animation, global overrides, Canvas substitution or new UI-host API.

Native mapping: https://docs.stencil.so/tern/elements/lists.md (`item`), https://docs.stencil.so/tern/elements/data.md (`icon`, `badge`), https://docs.stencil.so/tern/styles/variables.md , https://docs.stencil.so/tern/elements/el.md . Plain `el` buttons need explicit scoped styling; standalone `item` rows provide the native label/detail/value hierarchy without creating a new selection protocol.

## Verification boundary

Compare the actual connected Bridge panel against Tern's native Files/settings in Rail, at a narrow width, before claiming completion. A screenshot of an empty state or the website itself is not evidence of the connected implementation. Aesthetic acceptance remains the user's decision.
