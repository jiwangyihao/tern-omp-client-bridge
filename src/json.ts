// SPDX-License-Identifier: MPL-2.0
import { BridgeError, type DeviceDescriptor, type ToolResult } from "./protocol.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new BridgeError("INVALID_REQUEST", "Expected a JSON object");
	return value;
}

export function text(value: unknown, label: string, max = 4096): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) throw new BridgeError("INVALID_REQUEST", `Invalid ${label}`);
	return value;
}

export function integer(value: unknown, label: string, min = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw new BridgeError("INVALID_REQUEST", `Invalid ${label}`);
	return value;
}

export function deviceDescriptor(value: unknown): DeviceDescriptor {
	const input = record(value);
	const id = text(input.id, "client identity", 128);
	const name = text(input.name, "client display name", 128);
	if (!/^[A-Za-z0-9_-]+$/.test(id) || /[\x00-\x1f\x7f]/.test(name)) throw new BridgeError("INVALID_DEVICE", "Invalid client identity or display name");
	if (input.platform !== "darwin" && input.platform !== "win32" && input.platform !== "linux") throw new BridgeError("INVALID_DEVICE", "Unsupported platform identifier");
	return { id, name, platform: input.platform, arch: text(input.arch, "architecture", 32) };
}

export function toolResult(value: unknown): ToolResult {
	const input = record(value);
	if (!Array.isArray(input.content) || input.content.some(part => !isRecord(part) || (part.type !== "text" && part.type !== "image") || (part.type === "text" ? typeof part.text !== "string" : typeof part.data !== "string" || typeof part.mimeType !== "string"))) {
		throw new BridgeError("INVALID_RESULT", "The executor returned an invalid native tool result");
	}
	return input as unknown as ToolResult;
}

export function failure(error: unknown): { code: string; message: string } {
	if (error instanceof BridgeError) return { code: error.code, message: error.message };
	if (error instanceof Error) return { code: error.name === "AbortError" ? "CANCELLED" : "EXECUTION_FAILED", message: error.message };
	return { code: "EXECUTION_FAILED", message: String(error) };
}
