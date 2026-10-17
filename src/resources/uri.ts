// SPDX-License-Identifier: MPL-2.0
import { posix, win32 } from "node:path";
import { BridgeError, type Platform } from "../protocol.ts";

/** Includes malformed client addresses so callers reject them instead of falling back. */
export function isClientUri(value: string): boolean {
	return /^client:/i.test(value);
}

export function decodeClientUri(value: string, platform: Platform): string {
	if (!/^client:\/\/\//i.test(value) || /[\\#\u0000-\u001f\u007f]/.test(value)) {
		throw new BridgeError("INVALID_CLIENT_URI", "Use client:/// followed by a real absolute path; authorities, fragments and control characters are forbidden.");
	}
	// Query expressions are native protocol syntax, not a URL searchParams object.
	// In particular %26 inside a jq expression must remain escaped for native read.
	const queryIndex = value.indexOf("?");
	const encoded = queryIndex < 0 ? value.slice(9) : value.slice(9, queryIndex);
	const query = queryIndex < 0 ? "" : value.slice(queryIndex);
	let path: string;
	try {
		path = decodeURIComponent(encoded);
	} catch {
		throw new BridgeError("INVALID_CLIENT_URI", "Client path contains an invalid percent escape.");
	}
	if (/[\u0000-\u001f\u007f\\]/.test(path)) {
		throw new BridgeError("INVALID_CLIENT_URI", "Client URI paths must use forward slashes and cannot contain control characters.");
	}
	if (platform === "win32") {
		if (/^\/[A-Za-z]:\//.test(path)) return path.slice(1).replaceAll("/", "\\") + query;
		// UNC is a filesystem path with an empty URI authority, not a bridge device selector.
		if (/^\/\/[^/:]+\/[^/:]+(?:\/|$)/.test(path)) return path.replaceAll("/", "\\") + query;
		throw new BridgeError("INVALID_CLIENT_URI", "Windows client paths require an absolute drive path (client:///C:/...) or an authority-free UNC path.");
	}
	if (!path.startsWith("/") || path.startsWith("//")) {
		throw new BridgeError("INVALID_CLIENT_URI", "POSIX client paths require one leading slash and an empty authority.");
	}
	return path + query;
}

export function platformPath(platform: Platform): typeof posix {
	return platform === "win32" ? win32 : posix;
}

/** Encode actual filename characters without treating them as tool selectors. */
export function encodeClientPath(path: string, platform: Platform): string {
	const normalized = platform === "win32" ? path.replaceAll("\\", "/") : path;
	if (!platformPath(platform).isAbsolute(path)) {
		throw new BridgeError("INVALID_NATIVE_PATH", "Native file metadata must resolve to an absolute client path.");
	}
	const rooted = platform === "win32" && /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized;
	return `client://${rooted.split("/").map((part, index) => index === 1 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join("/")}`;
}

export function canonicalPath(path: string, platform: Platform): string {
	const normalized = platformPath(platform).normalize(path);
	return platform === "win32" ? normalized.toLowerCase() : normalized;
}
