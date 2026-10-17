// SPDX-License-Identifier: MPL-2.0
// UTF-8 C1 OSC, deliberately NOT ESC + ']': the public native input hook has
// no asynchronous raw-key replay. Holding an ESC prefix would swallow Escape.
const PREFIX = "\u009d777;tern-omp-client-bridge;";
// BEL is a native Ctrl+G shortcut before raw input listeners; use C1 ST instead.
const END = "\u009c";
const MAX_TOKEN_LENGTH = 128;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

export function encodeControlFrame(intentId: string): string {
	if (!TOKEN.test(intentId)) throw new Error("Invalid bridge intent identity");
	return PREFIX + intentId + END;
}

export class ControlFrameDecoder {
	#pending = "";

	push(data: string): { text: string; intentIds: string[] } {
		const input = this.#pending + data;
		this.#pending = "";
		const output: string[] = [];
		const intentIds: string[] = [];
		let offset = 0;
		while (offset < input.length) {
			const start = input.indexOf(PREFIX, offset);
			if (start === -1) {
				const tail = input.slice(offset);
				let held = Math.min(PREFIX.length - 1, tail.length);
				while (held > 0 && !PREFIX.startsWith(tail.slice(-held))) held--;
				output.push(held ? tail.slice(0, -held) : tail);
				this.#pending = held ? tail.slice(-held) : "";
				break;
			}
			output.push(input.slice(offset, start));
			const end = input.indexOf(END, start + PREFIX.length);
			if (end === -1) {
				if (input.length - start <= PREFIX.length + MAX_TOKEN_LENGTH) {
					this.#pending = input.slice(start);
					break;
				}
				output.push(PREFIX);
				offset = start + PREFIX.length;
				continue;
			}
			const token = input.slice(start + PREFIX.length, end);
			if (TOKEN.test(token)) intentIds.push(token);
			else output.push(input.slice(start, end + 1));
			offset = end + 1;
		}
		return { text: output.join(""), intentIds };
	}

	flush(): string {
		const text = this.#pending;
		this.#pending = "";
		return text;
	}
}
