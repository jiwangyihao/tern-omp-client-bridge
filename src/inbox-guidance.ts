// SPDX-License-Identifier: MPL-2.0
/** Shared human/agent guidance for immutable, per-upload receiving directories. */
export const INBOX_REMINDER = "Temporary receiving inbox — NOT a working directory. First copy/archive these files into an appropriate durable project location, tell the user where, then work on the archived copies.";

export const INBOX_README = `Client bridge receiving inbox

${INBOX_REMINDER}

This private directory contains completed, checksum-verified uploads. The numbered
files retain their transferred bytes; this README is bridge-generated guidance.
No project is selected automatically. Source files are not modified or moved.
Referenced uploads have no automatic expiry. Do not delete these files or this
inbox automatically: existing drafts or conversations may still refer to them.
`;
