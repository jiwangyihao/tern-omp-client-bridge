// SPDX-License-Identifier: MPL-2.0
/** Distinguish native image attachments from ordinary file references. */
export function isImageAttachment(path: string): boolean {
	return Bun.file(path).type.startsWith("image/");
}
