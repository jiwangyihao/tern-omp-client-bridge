// SPDX-License-Identifier: MPL-2.0
import type { InteractionDecision, InteractionRequest } from "../api.ts";

export type InteractionHandler = (request: InteractionRequest, signal?: AbortSignal) => Promise<InteractionDecision>;

/** A local human channel, not an approval flag supplied by the remote executor. */
export class LocalInteractions {
	constructor(private readonly contextId: string, private readonly handler?: InteractionHandler) {}

	async choose(title: string, message: string, choices: InteractionRequest["choices"], signal?: AbortSignal): Promise<string | null> {
		signal?.throwIfAborted();
		if (!this.handler) return null;
		const request: InteractionRequest = { id: crypto.randomUUID(), contextId: this.contextId, title, message, choices };
		const cancelled = Promise.withResolvers<never>();
		const abort = () => cancelled.reject(signal?.reason ?? new Error("Interaction cancelled"));
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const decision = await Promise.race([this.handler(request, signal), cancelled.promise]);
			signal?.throwIfAborted();
			return choices.some(choice => choice.id === decision.choice) ? decision.choice : null;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	async confirm(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean> {
		return await this.choose(title, message, [{ id: "yes", label: "Approve" }, { id: "no", label: "Deny" }], options?.signal) === "yes";
	}
}
