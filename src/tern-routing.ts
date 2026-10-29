// SPDX-License-Identifier: MPL-2.0
import path from "node:path";
import { BridgeError } from "./protocol.ts";

/** Validate a literal native endpoint, not an executable or shell command. */
export function isAbsoluteTernPaneSocketPath(value: unknown, platform: NodeJS.Platform = process.platform): value is string {
	if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
	if (platform !== "win32") return value.startsWith("/") && !value.endsWith("/");
	let native = value.replaceAll("\\", "/");
	if (native.startsWith("//?/")) {
		native = native.slice(4);
		if (native.slice(0, 4).toLowerCase() === "unc/") native = "//" + native.slice(4);
	}
	if (/["<>|?*]/u.test(native) || native.endsWith("/")) return false;
	if (/^[A-Za-z]:\/[^/]/u.test(native) && !native.slice(2).includes(":")) return true;
	const unc = /^\/\/([^/]+)\/([^/]+)\/([^/].*)$/u.exec(native);
	return unc !== null && ![".", ".."].includes(unc[1]!) && ![".", ".."].includes(unc[2]!) && !native.includes(":");
}

function requireEndpoint(value: unknown, source: string): string {
	if (isAbsoluteTernPaneSocketPath(value)) return value;
	throw new BridgeError("INVALID_TERN_PANE_SOCKET", `Invalid ${source}: provide an absolute native socket path without control characters; repair it with --tern-pane-socket.`);
}

/** Resolve machine-local routing during setup; daemon downtime must not erase it. */
export async function resolveTernPaneSocket({ explicit, saved, configDirectory, isolated = false }: {
	explicit?: string;
	saved?: unknown;
	configDirectory: string;
	isolated?: boolean;
}): Promise<string | undefined> {
	if (explicit !== undefined) return requireEndpoint(explicit, "--tern-pane-socket");
	if (isAbsoluteTernPaneSocketPath(saved)) return saved;
	// A target selects installation files, not a daemon. Never invent its route.
	if (isolated) return undefined;
	for (const variable of ["TERN_PANE_SOCKET", "TERN_DAEMON_SOCKET"] as const) {
		const value = process.env[variable];
		if (value) return requireEndpoint(value, variable);
	}

	// Official contract: $TERN_DAEMON_SOCKET, else daemon.sock in runtime/settings.
	// https://docs.stencil.so/tern/reference/cli.md
	// Settings are supplied by the caller (Windows: %APPDATA%\\Tern, not LOCALAPPDATA):
	// https://docs.stencil.so/tern/concepts/packages.md#directories
	// Linux `tern ls --json` (read-only, 2026-10-29) reports
	// $XDG_RUNTIME_DIR/tern/daemon.sock, or $TERN_CONFIG_DIR/daemon.sock when
	// XDG_RUNTIME_DIR is unset. No daemon/socket liveness check is appropriate here.
	// Native Windows fallback follows the documented settings-directory contract;
	// it has not been acceptance-tested on a Windows host.
	let directory = configDirectory;
	if (process.platform === "linux" && process.env.XDG_RUNTIME_DIR) {
		directory = requireEndpoint(path.join(process.env.XDG_RUNTIME_DIR, "tern"), "XDG_RUNTIME_DIR");
	}
	return requireEndpoint(path.join(directory, "daemon.sock"), "Tern settings directory");
}
