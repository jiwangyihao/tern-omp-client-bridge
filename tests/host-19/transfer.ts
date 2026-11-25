// SPDX-License-Identifier: MPL-2.0
// Synthetic human transfer through a real, newly paired loopback client. Never
// bind the client for tool use. The PTY driver checks the actual receiving draft.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startClientService } from "../../src/client.ts";
import { loadClientIdentity, readEndpoint } from "../../src/config.ts";
import { CaptureResultSchema, LocalUiStateSchema, TransferStatusSchema, UiIntentReceiptSchema } from "../../src/schemas.ts";

const root = process.env.BRIDGE_ACCEPTANCE_ROOT;
assert.ok(root && root === process.cwd());
const destinationId = process.argv[2];
assert.ok(destinationId);
const stateDir = join(root, "paired-client");
const client = await startClientService({
	stateDir, cwd: root, serverName: "Host acceptance", identity: await loadClientIdentity(stateDir, { name: "Transfer fixture" }),
	connection: { kind: "loopback", endpoint: await readEndpoint(join(root, "bridge/server.json")) },
});
try {
	const signal = AbortSignal.timeout(20_000);
	await client.waitForConnection(signal);
	const api = async (route: string, body?: unknown) => {
		const response = await fetch(client.endpoint.url + route, {
			method: body === undefined ? "GET" : "POST", signal,
			headers: { authorization: `Bearer ${client.endpoint.token}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		assert.ok(response.ok, `${route}: ${response.status}`);
		return response.json();
	};
	const state = async () => LocalUiStateSchema.parse(await api("/v1/state"));
	const viewId = "acceptance-pane";
	const receipt = UiIntentReceiptSchema.parse(await api("/v1/intents", { kind: "resolve", viewId, destinationId }));
	let view = (await state()).views[viewId];
	while (view?.resolveIntentId !== receipt.id) { await Bun.sleep(40); view = (await state()).views[viewId]; }
	assert.deepEqual(view.state.binding.clientIds, [], "human transfer must work without a bound device");
	const capture = CaptureResultSchema.parse(await api("/v1/captures", { kind: "files", paths: [join(root, "ordinary.txt"), join(root, "attached.png")] }));
	const transfer = TransferStatusSchema.parse(await api("/v1/transfers", {
		viewId, captureId: capture.id, expectedSessionId: view.sessionId, expectedDraftToken: view.draftToken, expectedResolveIntentId: receipt.id,
	}));
	for (;;) {
		const status = (await state()).transfers.find(item => item.id === transfer.id);
		if (status?.phase === "attached") break;
		assert.ok(status?.phase !== "failed" && status?.phase !== "cancelled", status?.error ?? "Transfer failed");
		await Bun.sleep(40);
	}
	await writeFile(join(root, "transfer-finished"), "attached", { flag: "wx" });
} finally { await client.close(); }
