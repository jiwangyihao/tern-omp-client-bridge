// SPDX-License-Identifier: MPL-2.0
import { z } from "zod";
import type { InteractionDecision, InteractionRequest } from "../api.ts";
import type { Capability, ExecuteRequest, ToolResult } from "../protocol.ts";
import { CapabilitySchema, ExecuteRequestSchema, IdentifierSchema, InteractionRequestSchema, ToolResultSchema } from "../schemas.ts";
import { RuntimeEnvironmentSchema, type RuntimeEnvironment } from "./environment.ts";

export type WorkerInput =
	| { type: "init"; cwd: string; stateDir: string; owner: string; contextId: string; capabilities: readonly Capability[]; hasInteractions: boolean }
	| { type: "execute"; request: ExecuteRequest }
	| { type: "abort"; requestId: string }
	| { type: "interaction"; id: string; decision: InteractionDecision }
	| { type: "close" };

export type WorkerOutput =
	| { type: "booted" }
	| { type: "ready"; environment: RuntimeEnvironment }
	| { type: "result"; requestId: string; result: ToolResult; retain: boolean }
	| { type: "update"; requestId: string; result: ToolResult; done?: boolean }
	| { type: "released"; requestId: string }
	| { type: "error"; requestId?: string; name: string; message: string; code?: string; retain?: boolean }
	| { type: "interaction"; requestId: string; request: InteractionRequest }
	| { type: "interaction-cancel"; id: string }
	| { type: "closed"; retainedState: boolean; errors: readonly string[] };

const InteractionDecisionSchema: z.ZodType<InteractionDecision> = z.object({ choice: z.string().nullable() });

export const WorkerInputSchema: z.ZodType<WorkerInput> = z.discriminatedUnion("type", [
	z.object({ type: z.literal("init"), cwd: z.string().min(1), stateDir: z.string().min(1), owner: IdentifierSchema, contextId: IdentifierSchema, capabilities: z.array(CapabilitySchema), hasInteractions: z.boolean() }),
	z.object({ type: z.literal("execute"), request: ExecuteRequestSchema }),
	z.object({ type: z.literal("abort"), requestId: IdentifierSchema }),
	z.object({ type: z.literal("interaction"), id: IdentifierSchema, decision: InteractionDecisionSchema }),
	z.object({ type: z.literal("close") }),
]);
export const WorkerOutputSchema: z.ZodType<WorkerOutput> = z.discriminatedUnion("type", [
	z.object({ type: z.literal("booted") }),
	z.object({ type: z.literal("ready"), environment: RuntimeEnvironmentSchema }),
	z.object({ type: z.literal("result"), requestId: IdentifierSchema, result: ToolResultSchema, retain: z.boolean() }),
	z.object({ type: z.literal("update"), requestId: IdentifierSchema, result: ToolResultSchema, done: z.boolean().optional() }),
	z.object({ type: z.literal("released"), requestId: IdentifierSchema }),
	z.object({ type: z.literal("error"), requestId: IdentifierSchema.optional(), name: z.string(), message: z.string(), code: z.string().optional(), retain: z.boolean().optional() }),
	z.object({ type: z.literal("interaction"), requestId: IdentifierSchema, request: InteractionRequestSchema }),
	z.object({ type: z.literal("interaction-cancel"), id: IdentifierSchema }),
	z.object({ type: z.literal("closed"), retainedState: z.boolean(), errors: z.array(z.string()) }),
]);

export function serializedError(error: unknown): { name: string; message: string; code?: string } {
	if (!(error instanceof Error)) return { name: "Error", message: String(error) };
	return { name: error.name, message: error.message, ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}) };
}
