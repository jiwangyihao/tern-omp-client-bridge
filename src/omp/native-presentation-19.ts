// SPDX-License-Identifier: MPL-2.0
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { isRecord } from "../json.ts";
import type { ToolName } from "../protocol.ts";

interface Result {
	readonly content: readonly { type: string; text?: string; mimeType?: string }[];
	readonly details?: unknown;
}

function title(name: ToolName, args: unknown): string {
	if (!isRecord(args)) return name;
	const subject = args.command ?? args.path ?? args.pattern ?? args.title ?? args.i ?? args.input ?? args.code;
	const client = typeof args.clientId === "string" ? ` [client: ${sanitizeText(args.clientId).split("\n", 1)[0]}]`
		: args.target === "client" ? " [client]" : "";
	const heading = `${name}${client}`;
	return typeof subject === "string" ? `${heading}: ${sanitizeText(subject.split("\n", 1)[0]!)}` : heading;
}

/**
 * In 19.2.1 TranscriptPresenter.#presentCard selects defaultPresenter for a
 * same-name override without hooks. With hooks, legacyPresenter calls the
 * host's registered presenter by name. Rows supply its terminal paint only:
 * legacyView retains that presenter's head and body for Tern. All seven
 * native presenters merge (ui/tools/{bash,edit,read,write,eval,grep,glob}).
 */
export function reactivePresentation(name: ToolName) {
	return {
		mergeCallAndResult: true,
		renderCall(args: unknown) {
			return { render: (_width: number) => [title(name, args)] };
		},
		renderResult(result: Result, { expanded }: { expanded: boolean }, _theme?: unknown, args?: unknown) {
			// Old sessions may still have a device path. Replace the path-backed
			// read body with text: ToolBlock appends registered image nodes from
			// result.content whenever its body draws no image. Never emit a media
			// node or alter the session's saved result. New results omit mediaPath.
			if (name === "read" && isRecord(result.details) && "clientBridge" in result.details && typeof result.details.mediaPath === "string") {
				return result.content.filter(part => part.type === "text").map(part => sanitizeText(part.text ?? "")).join("\n") || "Client read";
			}
			return { render(width: number) {
				const lines = [title(name, args)];
				for (const part of result.content) {
					const output = part.type === "text" ? sanitizeText(part.text ?? "") : part.type === "image" ? `[Image: ${sanitizeText(part.mimeType ?? "image")}]` : undefined;
					if (!output) continue;
					const rows = expanded ? Bun.wrapAnsi(output, Math.max(1, width), { hard: true, trim: false }).split("\n") : output.split("\n", 5);
					for (const row of rows) {
						if (!expanded && lines.length === 5) return [...lines, "…"];
						lines.push(row);
					}
				}
				return lines;
			} };
		},
	};
}
