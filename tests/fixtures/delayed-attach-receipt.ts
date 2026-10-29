// SPDX-License-Identifier: MPL-2.0
import type { ServerWebSocket } from "bun";
import type { Endpoint } from "../../src/config.ts";

/** Delays real broker attachment/cancellation replies; no request or outcome is fabricated. */
export function delayedAttachReceiptProxy(endpoint: Endpoint, delayCancellationReply = false) {
	const receipt = Promise.withResolvers<void>();
	const cancellation = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	const peers = new Map<ServerWebSocket<undefined>, WebSocket>();
	const attachRequests = new Set<string>();
	const cancelRequests = new Set<string>();
	const cancelled = Promise.withResolvers<void>();
	const heldCancellations: Array<() => void> = [];
	const held: Array<() => void> = [];
	let released = false;
	let attachRequestsSeen = 0;
	const server = Bun.serve<undefined>({
		hostname: "127.0.0.1", port: 0,
		fetch(request, server) {
			if (request.headers.get("authorization") !== `Bearer ${endpoint.token}`) return new Response("unauthorized", { status: 401 });
			if (server.upgrade(request, { data: undefined })) return;
			return new Response("not found", { status: 404 });
		},
		websocket: {
			open(socket) {
				const upstream = new WebSocket(`${endpoint.url.replace(/^http/, "ws")}/v1/connect`, { headers: { authorization: `Bearer ${endpoint.token}` } });
				peers.set(socket, upstream);
				upstream.onmessage = event => {
					const raw = String(event.data);
					const frame = JSON.parse(raw);
					if (frame.kind === "event" && frame.name === "intent.finished" && frame.body.kind === "attach") finished.resolve();
					if (delayCancellationReply && frame.kind === "result" && cancelRequests.has(frame.id)) {
						heldCancellations.push(() => { socket.send(raw); }); cancelled.resolve();
					} else if (!released && frame.kind === "result" && attachRequests.has(frame.id)) {
						held.push(() => { socket.send(raw); }); receipt.resolve();
					} else socket.send(raw);
				};
				upstream.onclose = () => socket.close();
				upstream.onerror = () => socket.close();
			},
			message(socket, data) {
				const raw = typeof data === "string" ? data : data.toString();
				const frame = JSON.parse(raw);
				if (frame.kind === "request" && frame.method === "ui.intent" && frame.body.kind === "attach") { attachRequests.add(frame.id); attachRequestsSeen++; }
				if (frame.kind === "request" && frame.method === "upload.cancel") { cancelRequests.add(frame.id); cancellation.resolve(); }
				peers.get(socket)!.send(raw);
			},
			close(socket) { peers.get(socket)?.close(); peers.delete(socket); },
		},
	});
	return {
		endpoint: { url: `http://127.0.0.1:${server.port}`, token: endpoint.token },
		receipt: receipt.promise, cancellation: cancellation.promise, finished: finished.promise, cancelled: cancelled.promise,
		get attachRequestsSeen() { return attachRequestsSeen; },
		release() { released = true; for (const send of held.splice(0)) send(); },
		releaseCancellation() { delayCancellationReply = false; for (const send of heldCancellations.splice(0)) send(); },
		async close() { for (const [socket, upstream] of peers) { upstream.close(); socket.close(); } await server.stop(true); },
	};
}
