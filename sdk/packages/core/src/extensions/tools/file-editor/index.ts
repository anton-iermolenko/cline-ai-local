import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import {
	type AgentTool,
	type AgentToolContext,
	createTool,
} from "@cline/shared";
import { readGlobalSettings } from "../../../services/global-settings";
import {
	createEditor,
	type FileEditorEngine,
	fileEditorToolDefinitions,
} from "./engine/editor.mjs";

export const FILE_EDITOR_TOOL_NAMES = [
	"editor",
	"read_file",
	"apply_draft",
	"create_from_draft",
	"draft_create",
	"draft_append",
	"draft_finalize",
	"draft_discard",
] as const;
export type FileEditorToolName = (typeof FILE_EDITOR_TOOL_NAMES)[number];
export const FILE_EDITOR_WRITE_TOOLS = [
	"editor",
	"apply_draft",
	"create_from_draft",
] as const;
export interface FileEditorOptions {
	maxChars?: number;
	draftChunkChars?: number;
	advertiseLengthBounds?: boolean;
	lockTimeoutMs?: number;
	/** Trusted host-only roots; paths are resolved before containment checks. */
	roots?: string[];
}
export interface FileEditorPreview {
	path: string;
	original_text: string;
	new_text: string;
	original_sha256?: string;
	operation: string;
}
export type FileEditorExecutor = (
	tool: FileEditorToolName | "preview",
	input: Record<string, unknown>,
	cwd: string,
	context: AgentToolContext,
) => Promise<Record<string, unknown>>;
const IDLE_MS = 30 * 60 * 1000;

function settings(options: FileEditorOptions): FileEditorOptions {
	return { ...readGlobalSettings().fileEditor, ...options };
}
export function resolveFileEditorPath(cwd: string, path: string): string {
	if (
		process.platform === "linux" &&
		(/^[A-Za-z]:[\\/]/.test(path) ||
			/^[/\\]{2}wsl(?:\.localhost|\$)[/\\]Ubuntu[/\\]/i.test(path))
	)
		return path;
	if (isAbsolute(path)) return path;
	if (win32.isAbsolute(path))
		throw new Error("Use a path in the editor execution host's filesystem");
	const absolute = resolve(cwd, path),
		rel = relative(resolve(cwd), absolute);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new Error("Relative editor paths must stay within the workspace");
	return absolute;
}
function normalizeInput(
	input: Record<string, unknown>,
	cwd: string,
): Record<string, unknown> {
	return typeof input.path === "string" && input.path
		? { ...input, path: resolveFileEditorPath(cwd, input.path) }
		: input;
}

/** One engine per conversation/agent/workspace; staged content never leaks between sessions. */
export function createFileEditorExecutor(
	options: FileEditorOptions = {},
): FileEditorExecutor {
	const configured = settings(options);
	const engines = new Map<
		string,
		{ engine: Promise<FileEditorEngine>; touched: number }
	>();
	return async (tool, raw, cwd, context) => {
		context.signal?.throwIfAborted();
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			throw new Error("Editor arguments must be an object");
		const now = Date.now();
		for (const [key, entry] of engines)
			if (now - entry.touched > IDLE_MS) engines.delete(key);
		const key = JSON.stringify([
			resolve(cwd),
			context.conversationId ?? context.sessionId ?? "default",
			context.agentId,
		]);
		let entry = engines.get(key);
		if (!entry) {
			if (engines.size >= 32)
				throw new Error(
					"Too many active editor contexts; finish or expire existing sessions",
				);
			entry = { engine: createEditor(configured), touched: now };
			engines.set(key, entry);
		}
		entry.touched = now;
		try {
			const engine = await entry.engine;
			context.signal?.throwIfAborted();
			if (tool === "preview") {
				if (
					!FILE_EDITOR_WRITE_TOOLS.includes(
						raw.tool as (typeof FILE_EDITOR_WRITE_TOOLS)[number],
					)
				)
					throw new Error("Only editor write operations have previews");
				const input = raw.arguments as Record<string, unknown>;
				if (!input || typeof input !== "object" || Array.isArray(input))
					throw new Error("Preview arguments must be an object");
				return await engine.preview(
					String(raw.tool),
					normalizeInput(input, cwd),
				);
			}
			return await engine.call(tool, normalizeInput(raw, cwd), context.signal);
		} catch (error) {
			if (context.signal?.aborted) throw error;
			const detail = error as Error & {
				code?: string;
				recovery?: unknown;
				diagnostics?: unknown;
			};
			const failure: Record<string, unknown> = {
				success: false,
				error: detail.message?.slice(0, 1500) ?? "Editor operation failed",
				...(detail.code ? { code: detail.code } : {}),
				...(detail.recovery ? { recovery: detail.recovery } : {}),
				...(detail.diagnostics ? { diagnostics: detail.diagnostics } : {}),
			};
			if (JSON.stringify(failure).length > 8000) {
				delete failure.recovery;
				delete failure.diagnostics;
				failure.next_step =
					"Read the current file, then resend one corrected call with all required arguments; never guess missing content.";
			}
			throw new Error(JSON.stringify(failure));
		}
	};
}

export function createFileEditorTools(
	executor: FileEditorExecutor,
	config: {
		cwd?: string;
		timeoutMs?: number;
		options?: FileEditorOptions;
	} = {},
): AgentTool[] {
	const options = settings(config.options ?? {});
	return fileEditorToolDefinitions(
		options.maxChars ?? 50_000,
		options.advertiseLengthBounds ?? true,
		options.draftChunkChars,
	).map((definition) =>
		createTool({
			name: definition.name,
			description: definition.description,
			inputSchema: definition.inputSchema as AgentTool["inputSchema"],
			timeoutMs: config.timeoutMs ?? 30_000,
			retryable: false,
			maxRetries: 0,
			execute: async (input: unknown, context: AgentToolContext) => {
				const signal = context.signal
					? AbortSignal.any([
							context.signal,
							AbortSignal.timeout(config.timeoutMs ?? 30_000),
						])
					: AbortSignal.timeout(config.timeoutMs ?? 30_000);
				return executor(
					definition.name as FileEditorToolName,
					input as Record<string, unknown>,
					config.cwd ?? process.cwd(),
					{ ...context, signal },
				);
			},
		}),
	);
}
