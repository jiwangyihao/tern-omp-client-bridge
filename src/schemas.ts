// SPDX-License-Identifier: MPL-2.0
import { z } from "zod";

export const IdentifierSchema = z.string().min(1).max(256);
export const CapabilitySchema = z.enum(["files", "exec", "computer", "browser", "adb"]);
export const DeviceDescriptorSchema = z.object({
	id: IdentifierSchema.regex(/^[A-Za-z0-9_-]+$/),
	name: z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f]+$/),
	platform: z.enum(["darwin", "win32", "linux"]),
	arch: z.string().min(1).max(32),
	capabilities: z.array(CapabilitySchema).max(5),
});
export const DeviceStatusSchema = DeviceDescriptorSchema.extend({ online: z.boolean() });
export const BindingChangeSchema = z.object({
	revision: z.number().int().nonnegative(), actor: z.object({ id: IdentifierSchema, name: z.string() }),
	previousClientId: IdentifierSchema.nullable(), clientId: IdentifierSchema.nullable(), at: z.string(),
});
export const BindingStateSchema = z.object({ sessionId: IdentifierSchema, clientId: IdentifierSchema.nullable(), revision: z.number().int().nonnegative(), change: BindingChangeSchema.nullable() });
export const ServerStateSchema = z.object({ serverInstance: IdentifierSchema, binding: BindingStateSchema, devices: z.array(DeviceStatusSchema) });
export const ImportedFileSchema = z.object({ name: z.string(), path: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const UiClaimSchema = z.object({ id: IdentifierSchema, kind: z.enum(["resolve", "bind", "attach"]), state: ServerStateSchema, files: z.array(ImportedFileSchema).optional() });
export const UiIntentSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("resolve"), viewId: IdentifierSchema }),
	z.object({ kind: z.literal("bind"), viewId: IdentifierSchema, sessionId: IdentifierSchema, clientId: IdentifierSchema.nullable(), expectedRevision: z.number().int().nonnegative() }),
	z.object({ kind: z.literal("attach"), viewId: IdentifierSchema, sessionId: IdentifierSchema, draftToken: IdentifierSchema, transferId: IdentifierSchema }),
]);
export const ToolNameSchema = z.enum(["read", "write", "edit", "grep", "glob", "bash", "eval"]);
export const InvocationSchema = z.object({ sessionId: IdentifierSchema, contextId: IdentifierSchema, tool: ToolNameSchema, params: z.record(z.string(), z.unknown()) });
export const InvocationTargetSchema = z.object({ requestId: IdentifierSchema, sessionId: IdentifierSchema, contextId: IdentifierSchema, bindingRevision: z.number().int().nonnegative(), device: DeviceDescriptorSchema });
export const ExecuteRequestSchema = z.object({ target: InvocationTargetSchema, tool: ToolNameSchema, params: z.record(z.string(), z.unknown()) });
export const ToolResultSchema = z.object({
	content: z.array(z.union([
		z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
		z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }).passthrough(),
	])),
	details: z.unknown().optional(),
}).passthrough();
export const BackgroundResultSchema = z.object({ target: InvocationTargetSchema, result: ToolResultSchema });
export const EndpointSchema = z.object({ url: z.string().url(), token: z.string().min(16).max(256), pid: z.number().int().positive().optional() });
export const ClientIdentitySchema = z.object({ device: DeviceDescriptorSchema, publicKey: z.string().min(1).max(4096), privateKey: z.string().min(1).max(4096) });
export const UiIntentReceiptSchema = z.object({ id: IdentifierSchema, frame: z.string().min(1).max(4096), expiresAt: z.number().finite() });
export const ResolvedViewSchema = z.object({ viewId: IdentifierSchema, resolveIntentId: IdentifierSchema, sessionId: IdentifierSchema, draftToken: IdentifierSchema, state: ServerStateSchema });
export const InteractionRequestSchema = z.object({ id: IdentifierSchema, contextId: IdentifierSchema, title: z.string(), message: z.string(), choices: z.array(z.object({ id: IdentifierSchema, label: z.string() })) });
export const TransferStatusSchema = z.object({ id: IdentifierSchema, viewId: IdentifierSchema, source: DeviceDescriptorSchema, phase: z.enum(["captured", "uploading", "ready", "attached", "failed", "cancelled"]), bytesSent: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative(), names: z.array(z.string()), frame: z.string().optional(), error: z.string().optional() });
export const LocalUiStateSchema = z.object({ device: DeviceDescriptorSchema, connected: z.boolean(), serverName: z.string(), views: z.record(z.string(), ResolvedViewSchema), transfers: z.array(TransferStatusSchema), interactions: z.array(InteractionRequestSchema) });
export const CaptureResultSchema = z.object({ id: IdentifierSchema, kind: z.literal("files"), names: z.array(z.string()) });
