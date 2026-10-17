// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type { OwnedResource } from "../api.ts";
import { BridgeError, type ExecuteRequest, type ExecutionOptions, type InvocationTarget, type ToolResult } from "../protocol.ts";
import { Snapshots } from "./snapshots.ts";
import { canonicalPath, decodeClientUri, encodeClientPath, isClientUri, platformPath } from "./uri.ts";

export { decodeClientUri, isClientUri } from "./uri.ts";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Handle {
	readonly target: InvocationTarget;
	readonly native: string;
	readonly external: string;
}

/** Adapter only: all filesystem, image, edit and process behavior belongs to native OMP. */
export class ClientResources {
	readonly #invokeNative: (request: ExecuteRequest, options?: ExecutionOptions) => Promise<ToolResult>;
	readonly #snapshots = new Snapshots();
	readonly #handles = new Map<string, Handle>();
	readonly #nativeHandles = new Map<string, Handle>();
	readonly #epochs = new Map<string, number>();

	constructor(invokeNative: (request: ExecuteRequest, options?: ExecutionOptions) => Promise<ToolResult>) {
		this.#invokeNative = invokeNative;
	}

	resolveOwnedHandle(sessionId: string, contextId: string, path: string, requestId: string): OwnedResource | null {
		if (!/^(?:artifact|proc):\/\/client-/i.test(path)) return null;
		const match = /^((?:artifact|proc):\/\/client-[a-f0-9-]+)(.*)$/.exec(path);
		const handle = match ? this.#handles.get(match[1]!) : undefined;
		if (!handle || handle.target.sessionId !== sessionId || handle.target.contextId !== contextId) {
			throw new BridgeError("UNKNOWN_CLIENT_HANDLE", "This client resource handle is unknown, expired or belongs to another conversation/execution context.");
		}
		const suffix = match![2]!;
		if (suffix && !suffix.startsWith(":") && !suffix.startsWith("?") && !(handle.native.startsWith("proc://") && (suffix === "/kill" || suffix === "/mode"))) {
			throw new BridgeError("INVALID_CLIENT_HANDLE", "Only native read selectors or proc /kill and /mode actions may follow a client handle.");
		}
		if (/[\u0000-\u001f\u007f]/.test(suffix)) throw new BridgeError("INVALID_CLIENT_HANDLE", "Resource selectors cannot contain control characters.");
		return { target: { ...handle.target, requestId }, path: handle.native + suffix };
	}

	forgetContext(contextId: string): void {
		this.#epochs.set(contextId, (this.#epochs.get(contextId) ?? 0) + 1);
		this.#snapshots.forgetContext(contextId);
		for (const [uri, handle] of this.#handles) if (handle.target.contextId === contextId) this.#handles.delete(uri);
		for (const [key, handle] of this.#nativeHandles) if (handle.target.contextId === contextId) this.#nativeHandles.delete(key);
	}

	async execute(request: ExecuteRequest, options?: ExecutionOptions): Promise<ToolResult> {
		let target = request.target;
		let params = { ...request.params };
		if (typeof params.path === "string") {
			const owned = this.resolveOwnedHandle(target.sessionId, target.contextId, params.path, target.requestId);
			if (owned) {
				if (request.tool !== "read" && request.tool !== "write") throw new BridgeError("INVALID_CLIENT_HANDLE", "Client lifecycle handles support read and write only.");
				target = owned.target;
				params.path = owned.path;
			}
		}
		// Keep registry ownership immutable even if an invoker mutates its input object.
		target = Object.freeze({ ...target, device: Object.freeze({ ...target.device, capabilities: Object.freeze([...target.device.capabilities]) }) });
		const platform = target.device.platform;
		if (request.tool === "edit") {
			if (typeof params.input !== "string") throw new BridgeError("INVALID_CLIENT_EDIT", "Client edits require the native hashline input form.");
			params = { ...params, input: this.#snapshots.translate(params.input, target) };
		} else if (request.tool === "read" || request.tool === "write" || request.tool === "grep" || request.tool === "glob") {
			if (typeof params.path !== "string" || !params.path) throw new BridgeError("CLIENT_PATH_REQUIRED", "Client file operations require an explicit client:/// path.");
			const paths = request.tool === "grep" || request.tool === "glob" ? params.path.split(";") : [params.path];
			params.path = paths.map(path => {
				if (isClientUri(path)) return this.#snapshots.decode(path, target);
				if ((request.tool === "read" || request.tool === "write") && this.#knownNativeHandle(target, path)) return path;
				throw new BridgeError("MIXED_CLIENT_PATHS", "All client file paths must be client:/// URIs or bridge-owned lifecycle handles; agent paths are never used as a fallback.");
			}).join(";");
		} else if (request.tool === "bash" && typeof params.cwd === "string" && isClientUri(params.cwd)) {
			params.cwd = decodeClientUri(params.cwd, platform);
		}
		const native: ExecuteRequest = { target, tool: request.tool, params };
		const epoch = this.#epochs.get(target.contextId) ?? 0;
		const result = await this.#invokeNative(native, options ? {
			...options,
			onUpdate: options.onUpdate ? update => {
				if ((this.#epochs.get(target.contextId) ?? 0) === epoch) options.onUpdate?.(this.#result(native, update));
			} : undefined,
			onBackgroundResult: options.onBackgroundResult ? update => {
				if ((this.#epochs.get(target.contextId) ?? 0) === epoch) options.onBackgroundResult?.(this.#result(native, update));
			} : undefined,
		} : undefined);
		if ((this.#epochs.get(target.contextId) ?? 0) !== epoch) throw new BridgeError("CLIENT_CONTEXT_CLOSED", "The client execution context closed before this result arrived.");
		return this.#result(native, result);
	}

	#handle(target: InvocationTarget, native: string, links: Set<string>): string {
		const match = /^(artifact|proc):\/\/([^/:?\s]+)(.*)$/.exec(native);
		if (!match) throw new BridgeError("INVALID_NATIVE_HANDLE", "Native resource metadata contains an invalid artifact or process reference.");
		const base = `${match[1]}://${match[2]}`;
		const key = JSON.stringify([target.sessionId, target.contextId, target.device.id, base]);
		let handle = this.#nativeHandles.get(key);
		if (!handle) {
			handle = { target, native: base, external: `${match[1]}://client-${randomUUID()}` };
			this.#nativeHandles.set(key, handle);
			this.#handles.set(handle.external, handle);
		}
		links.add(handle.external);
		return handle.external + match[3];
	}

	#knownNativeHandle(target: InvocationTarget, path: string): boolean {
		const match = /^(artifact|proc):\/\/([^/:?\s]+)(.*)$/.exec(path);
		if (!match) return false;
		const handle = this.#nativeHandles.get(JSON.stringify([target.sessionId, target.contextId, target.device.id, `${match[1]}://${match[2]}`]));
		if (!handle) return false;
		this.resolveOwnedHandle(target.sessionId, target.contextId, handle.external + match[3], target.requestId);
		return true;
	}

	backgroundResult(request: ExecuteRequest, result: ToolResult): ToolResult {
		return this.#result(request, result);
	}

	#result(request: ExecuteRequest, result: ToolResult): ToolResult {
		const { target, tool, params } = request;
		const details = record(result.details) ? result.details : undefined;
		const links = new Set<string>();
		const pathApi = platformPath(target.device.platform);
		const cwd = typeof details?.cwd === "string" ? details.cwd : undefined;
		const absolute = (value: string): string | undefined => {
			if (pathApi.isAbsolute(value)) return value;
			return cwd && pathApi.isAbsolute(cwd) ? pathApi.resolve(cwd, value) : undefined;
		};
		const fileUri = (value: string): string => {
			const path = absolute(value);
			return path ? encodeClientPath(path, target.device.platform) : value;
		};
		const meta = record(details?.meta) ? details.meta : undefined;
		const source = record(meta?.source) ? meta.source : undefined;
		const sourcePath = source?.type === "path" && typeof source.value === "string" ? source.value : undefined;
		const nativePath = typeof params.path === "string" ? params.path : undefined;
		const lifecycleRead = tool === "read" && nativePath !== undefined && /^(?:artifact|proc):\/\//.test(nativePath);
		const rawRead = tool === "read" && nativePath !== undefined && /:raw(?=:|\?|$)/.test(nativePath);

		// SDK18.10.4 read-format.ts:116 prepends exactly one snapshot header.
		// Raw reads have no protocol header: their first line is user content.
		const readHeader = (text: string): string => {
			if (rawRead || lifecycleRead || result.isError || !sourcePath) return text;
			let offset = 0;
			if (record(details?.suffixResolution)) {
				const { from, to } = details.suffixResolution;
				const notice = `[Path '${from}' not found; resolved to '${to}' via suffix match]\n`;
				if (text.startsWith(notice)) offset = notice.length;
			}
			const match = /^\[([^\n]+)#([a-f0-9]{4})\](?=\r?\n|$)/i.exec(text.slice(offset));
			return match ? text.slice(0, offset) + this.#snapshots.header(target, sourcePath, match[2]!) + text.slice(offset + match[0].length) : text;
		};

		// grep bodies always have numeric gutters (grep.ts:970-976); only # and
		// [path#tag] header positions are metadata, never body substring matches.
		const searchHeaders = (text: string): string => {
			if (result.isError || !Array.isArray(details?.files)) return text;
			const allowed = new Set(details.files.filter((file): file is string => typeof file === "string").map(absolute).filter((file): file is string => file !== undefined).map(file => canonicalPath(file, target.device.platform)));
			const directories = new Map<number, string>();
			return text.split("\n").map(line => {
				const flat = /^\[(.+)#([a-f0-9]{4})\]$/i.exec(line);
				if (flat) {
					const path = absolute(flat[1]!);
					return path && allowed.has(canonicalPath(path, target.device.platform)) ? this.#snapshots.header(target, path, flat[2]!) : line;
				}
				const header = /^(#+) (.+)$/.exec(line);
				if (!header) return line;
				const depth = header[1]!.length;
				const parent = depth === 1 ? cwd : directories.get(depth - 1);
				for (const level of directories.keys()) if (level >= depth) directories.delete(level);
				const tagged = /^(.*)#([a-f0-9]{4})$/i.exec(header[2]!);
				const name = tagged?.[1] ?? header[2]!;
				const path = pathApi.isAbsolute(name) ? name : parent ? pathApi.resolve(parent, name) : undefined;
				if (!path) return line;
				if (name.endsWith("/")) {
					directories.set(depth, path);
					return `${header[1]} ${encodeClientPath(path, target.device.platform)}/`;
				}
				if (!allowed.has(canonicalPath(path, target.device.platform))) return line;
				return tagged ? this.#snapshots.header(target, path, tagged[2]!) : `${header[1]} ${encodeClientPath(path, target.device.platform)}`;
			}).join("\n");
		};

		const editPaths: string[] = [];
		if (tool === "edit" && details) {
			const files = Array.isArray(details.perFileResults) ? details.perFileResults : [details];
			for (const file of files) if (record(file) && typeof file.path === "string") editPaths.push(file.path);
		}
		const editHeaders = (text: string): string => text.split("\n").map(line => {
			const match = /^\[(.+)#([a-f0-9]{4})\]$/i.exec(line);
			if (!match) return line;
			const path = editPaths.find(file => file === match[1] || (cwd && pathApi.relative(cwd, file) === match[1]));
			return path ? this.#snapshots.header(target, path, match[2]!) : line;
		}).join("\n");

		const mapMeta = (value: unknown): unknown => {
			if (!record(value)) return value;
			const mapped = { ...value };
			for (const key of ["truncation", "limits"] as const) {
				if (!record(value[key])) continue;
				const part = { ...value[key] };
				if (typeof part.artifactId === "string") part.artifactId = this.#handle(target, `artifact://${part.artifactId}`, links).slice(11);
				if (record(part.columnTruncated)) {
					const columns = { ...part.columnTruncated };
					if (typeof columns.artifactId === "string") columns.artifactId = this.#handle(target, `artifact://${columns.artifactId}`, links).slice(11);
					if (typeof columns.selectorBase === "string") columns.selectorBase = /^(?:artifact|proc):\/\//.test(columns.selectorBase) ? this.#handle(target, columns.selectorBase, links) : fileUri(columns.selectorBase);
					part.columnTruncated = columns;
				}
				mapped[key] = part;
			}
			if (record(value.source) && typeof value.source.value === "string") {
				const sourceValue = lifecycleRead ? nativePath! : value.source.value;
				mapped.source = { ...value.source, value: /^(?:artifact|proc):\/\//.test(sourceValue) ? this.#handle(target, sourceValue, links) : value.source.type === "path" ? fileUri(sourceValue) : sourceValue };
			}
			return mapped;
		};
		const mapDetails = (value: unknown): unknown => {
			if (!record(value)) return value;
			const mapped = { ...value };
			if (value.meta !== undefined) mapped.meta = mapMeta(value.meta);
			if (record(value.async) && typeof value.async.jobId === "string") mapped.async = { ...value.async, jobId: this.#handle(target, `proc://${value.async.jobId}`, links).slice(7) };
			if (record(value.service) && typeof value.service.name === "string") mapped.service = { ...value.service, name: this.#handle(target, `proc://${value.service.name}`, links).slice(7) };
			if (tool === "read" || tool === "write" || tool === "edit" || tool === "grep" || tool === "glob") {
				for (const key of ["path", "sourcePath", "move", "cwd", "searchPath", "scopePath"] as const) if (typeof value[key] === "string") mapped[key] = fileUri(value[key]);
				for (const key of ["files", "missingPaths"] as const) if (Array.isArray(value[key])) mapped[key] = value[key].map(item => typeof item === "string" ? fileUri(item) : item);
				if (Array.isArray(value.fileMatches)) mapped.fileMatches = value.fileMatches.map(item => record(item) && typeof item.path === "string" ? { ...item, path: fileUri(item.path) } : item);
				if (Array.isArray(value.perFileResults)) mapped.perFileResults = value.perFileResults.map(mapDetails);
				if (tool === "grep" && typeof value.displayContent === "string") mapped.displayContent = searchHeaders(value.displayContent);
			}
			// Process snapshots contain nested native tool results, not arbitrary Eval JSON.
			if (record(value.proc)) mapped.proc = mapProcess(value.proc);
			return mapped;
		};
		const mapProcess = (value: Record<string, unknown>): Record<string, unknown> => {
			const mapped = { ...value };
			for (const key of ["job", "daemon"] as const) if (record(value[key])) mapped[key] = mapProcessEntry(value[key], key === "daemon");
			for (const key of ["jobs", "daemons"] as const) if (Array.isArray(value[key])) mapped[key] = value[key].map(item => record(item) ? mapProcessEntry(item, key === "daemons") : item);
			return mapped;
		};
		const mapProcessEntry = (value: Record<string, unknown>, daemon: boolean): Record<string, unknown> => {
			const mapped = { ...value };
			const key = daemon ? "name" : "id";
			if (typeof value[key] === "string") mapped[key] = this.#handle(target, `proc://${value[key]}`, links).slice(7);
			for (const field of ["latestDetails", "details"] as const) if (record(value[field])) mapped[field] = mapDetails(value[field]);
			if (record(value.result) && Array.isArray(value.result.content)) mapped.result = { ...value.result, details: mapDetails(value.result.details) };
			return mapped;
		};
		const mappedDetails = mapDetails(result.details);
		const content = result.content.map(item => item.type !== "text" ? item : {
			...item,
			text: tool === "read" ? readHeader(item.text) : tool === "grep" ? searchHeaders(item.text) : tool === "edit" ? editHeaders(item.text) : item.text,
		});
		if (tool === "eval" || tool === "bash") content.push({ type: "text", text: `Client result from ${JSON.stringify(target.device.name)} (${target.device.id}, ${target.device.platform}); request ${target.requestId}, binding revision ${target.bindingRevision}.` });
		if (tool === "glob" && Array.isArray(details?.files) && details.files.length) {
			const files = details.files.filter((item): item is string => typeof item === "string").map(fileUri);
			content.push({ type: "text", text: `[Client paths]\n${files.join("\n")}` });
		}
		if (links.size) content.push({ type: "text", text: `[Client-owned resources; use these handles for reads and lifecycle operations]\n${[...links].join("\n")}` });
		const attributedDetails = record(mappedDetails) ? { ...mappedDetails, clientBridge: { target } } : { clientBridge: { target, nativeDetails: mappedDetails } };
		return { ...result, content, details: attributedDetails };
	}
}
