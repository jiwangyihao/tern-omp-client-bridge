// SPDX-License-Identifier: MPL-2.0
import { z } from "zod";

/** Observed executable discovery plus explicit, unprobed native-backend prerequisites. */
export interface RuntimeEnvironment {
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	readonly cwd: string;
	readonly sdkVersion: string;
	readonly ordinaryShell: {
		readonly backend: "native-brush";
		readonly syntax: "POSIX";
		readonly persistence: "per-context";
		readonly automaticBackgrounding: false;
	};
	readonly serviceShell: { readonly executable: string; readonly args: readonly string[]; readonly prefix?: string };
	readonly adb: { readonly executable: string | null; readonly available: boolean; readonly deviceAccess: "not-probed"; readonly requirement: string };
	readonly browser: { readonly defaultBackend: "headless-chromium"; readonly availability: "not-probed" | "disabled"; readonly ownership: "context"; readonly requirement: string };
	readonly computer: { readonly availability: "not-probed" | "disabled"; readonly requirement: string };
	readonly limits: readonly string[];
}

export const RuntimeEnvironmentSchema: z.ZodType<RuntimeEnvironment> = z.object({
	platform: z.enum(["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"]),
	arch: z.string(), cwd: z.string(), sdkVersion: z.string(),
	ordinaryShell: z.object({ backend: z.literal("native-brush"), syntax: z.literal("POSIX"), persistence: z.literal("per-context"), automaticBackgrounding: z.literal(false) }),
	serviceShell: z.object({ executable: z.string(), args: z.array(z.string()), prefix: z.string().optional() }),
	adb: z.object({ executable: z.string().nullable(), available: z.boolean(), deviceAccess: z.literal("not-probed"), requirement: z.string() }),
	browser: z.object({ defaultBackend: z.literal("headless-chromium"), availability: z.enum(["not-probed", "disabled"]), ownership: z.literal("context"), requirement: z.string() }),
	computer: z.object({ availability: z.enum(["not-probed", "disabled"]), requirement: z.string() }),
	limits: z.array(z.string()),
});
