// SPDX-License-Identifier: MPL-2.0
/** Pure-plugin scope: image attachments require a native atomic draft-completion API. */
export function isImageAttachment(path: string): boolean {
	return Bun.file(path).type.startsWith("image/");
}
