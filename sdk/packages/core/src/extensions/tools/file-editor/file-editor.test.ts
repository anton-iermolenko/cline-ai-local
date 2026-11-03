import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filterDisabledTools } from "../../../services/global-settings";
import { createBuiltinTools } from "../index";
import { getCoreBuiltinToolCatalog } from "../runtime";
import {
	createFileEditorExecutor,
	createFileEditorTools,
	FILE_EDITOR_TOOL_NAMES,
} from "./index";

const dirs: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});
async function workspace() {
	const dir = await mkdtemp(join(tmpdir(), "cline-native-editor-"));
	dirs.push(dir);
	return dir;
}
const context: AgentToolContext = {
	agentId: "writer",
	conversationId: "fixture-conversation",
	iteration: 0,
};
function family(cwd: string, timeoutMs = 30_000) {
	const tools = createFileEditorTools(createFileEditorExecutor(), {
		cwd,
		timeoutMs,
	});
	return {
		tools,
		call: async (
			name: string,
			input: Record<string, unknown> = {},
			ctx = context,
		) =>
			tools.find((tool) => tool.name === name)!.execute(input, ctx) as Promise<
				Record<string, unknown>
			>,
	};
}
describe("native file editor family", () => {
	it("advertises the eight operation-specific contracts under one editor catalog entry", () => {
		const tools = createBuiltinTools();
		for (const name of FILE_EDITOR_TOOL_NAMES)
			expect(tools.filter((tool) => tool.name === name)).toHaveLength(1);
		expect(
			getCoreBuiltinToolCatalog({ mode: "act" }).find(
				(entry) => entry.id === "editor",
			)?.headlessToolNames,
		).toEqual([...FILE_EDITOR_TOOL_NAMES]);
		const editor = tools.find((tool) => tool.name === "editor")!;
		expect(editor.inputSchema).toMatchObject({
			required: ["path", "new_text"],
			properties: { new_text: { maxLength: 50000 } },
		});
		const append = tools.find((tool) => tool.name === "draft_append")!;
		expect(append.description).toContain(
			"Maximum content length: 8000 characters",
		);
		expect(append.inputSchema).toMatchObject({
			properties: {
				content: {
					description: expect.stringContaining(
						"Maximum content length: 8000 characters",
					),
				},
			},
		});
		expect(
			(append.inputSchema as { properties: { content: object } }).properties
				.content,
		).not.toHaveProperty("maxLength");
		expect(
			tools.find((tool) => tool.name === "apply_draft")?.inputSchema,
		).toMatchObject({
			required: [
				"path",
				"new_text_ref",
				"start_line",
				"end_line",
				"expected_sha256",
			],
		});
	});
	it("creates a missing file with empty old_text using the same preview and commit", async () => {
		const dir = await workspace();
		const execute = createFileEditorExecutor();
		const input = { path: "new.txt", old_text: "", new_text: "created\n" };
		const preview = await execute(
			"preview",
			{ tool: "editor", arguments: input },
			dir,
			context,
		);
		expect(preview).toMatchObject({
			operation: "create",
			original_text: "",
			new_text: input.new_text,
		});
		await expect(access(join(dir, input.path))).rejects.toThrow();
		const result = await execute("editor", input, dir, context);
		expect(result).toMatchObject({ success: true, operation: "create" });
		expect(await readFile(join(dir, input.path), "utf8")).toBe(
			preview.new_text,
		);
		await expect(
			execute("editor", { ...input, new_text: "oops" }, dir, context),
		).rejects.toThrow("Existing file requires nonempty old_text");
		expect(await readFile(join(dir, input.path), "utf8")).toBe(input.new_text);
	});
	it("writes a complete inline payload above the former 6K guard and returns the saved-byte hash", async () => {
		const dir = await workspace(),
			{ call } = family(dir),
			text = 'quoted "payload" $&\n'.repeat(1800);
		const result = await call("editor", {
			path: "nested/content.txt",
			new_text: text,
		});
		expect(await readFile(join(dir, "nested/content.txt"), "utf8")).toBe(text);
		expect(result).toMatchObject({
			success: true,
			bytes: Buffer.byteLength(text),
			sha256: createHash("sha256").update(text).digest("hex"),
		});
	});
	it("stages content without writing, rejects stale ranges and applies only a finalized draft", async () => {
		const dir = await workspace(),
			file = join(dir, "file.txt"),
			{ call } = family(dir);
		await writeFile(file, "old\ntail\n");
		const before = await call("read_file", { path: file });
		const draft = await call("draft_create");
		expect(draft.max_chunk_chars).toBe(8000);
		const content = 'new "quoted" $& data\n'.repeat(500);
		let latest = draft;
		for (let index = 0; index * 8000 < content.length; index++)
			latest = await call("draft_append", {
				id: draft.id,
				chunk_index: index,
				content: content.slice(index * 8000, (index + 1) * 8000),
			});
		expect(await readFile(file, "utf8")).toBe("old\ntail\n");
		await expect(
			call("apply_draft", {
				path: file,
				new_text_ref: draft.id,
				start_line: 1,
				end_line: 1,
				expected_sha256: before.sha256,
			}),
		).rejects.toThrow("not finalized");
		await call("draft_finalize", {
			id: draft.id,
			chunk_count: latest.next_chunk_index,
			expected_sha256: latest.sha256,
		});
		await writeFile(file, "changed\ntail\n");
		await expect(
			call("apply_draft", {
				path: file,
				new_text_ref: draft.id,
				start_line: 1,
				end_line: 1,
				expected_sha256: before.sha256,
			}),
		).rejects.toThrow("hash changed");
		const fresh = await call("read_file", { path: file });
		await call("apply_draft", {
			path: file,
			new_text_ref: draft.id,
			start_line: 1,
			end_line: 1,
			expected_sha256: fresh.sha256,
		});
		expect(await readFile(file, "utf8")).toBe(content + "tail\n");
	});
	it("uses configured chunk limits independently of inline limits and recovers without losing accepted content", async () => {
		const dir = await workspace();
		vi.stubEnv("CLINE_GLOBAL_SETTINGS_PATH", join(dir, "settings.json"));
		await writeFile(
			join(dir, "settings.json"),
			JSON.stringify({
				fileEditor: { maxChars: 100, draftChunkChars: 6000 },
			}),
		);
		const { tools, call } = family(dir);
		expect(
			tools.find((tool) => tool.name === "draft_append")!.description,
		).toContain("Maximum content length: 6000 characters");
		const draft = await call("draft_create");
		expect(draft.max_chunk_chars).toBe(6000);
		const chunk = { id: draft.id, chunk_index: 0, content: "x".repeat(6000) };
		const first = await call("draft_append", chunk);
		expect(first.max_chunk_chars).toBe(6000);
		try {
			await call("draft_append", {
				id: draft.id,
				chunk_index: 1,
				content: "x".repeat(6001),
			});
			throw new Error("Expected oversized chunk rejection");
		} catch (error) {
			expect(JSON.parse((error as Error).message)).toMatchObject({
				code: "draft_chunk_too_large",
				error:
					"Received 6001 characters; maximum 6000. Nothing was appended. Resend smaller chunks starting at index 1.",
				diagnostics: {
					actual_chars: 6001,
					max_chunk_chars: 6000,
					next_chunk_index: 1,
				},
				recovery: {
					active_drafts: [
						{
							id: draft.id,
							sha256: first.sha256,
							chars: 6000,
							max_chunk_chars: 6000,
							next_chunk_index: 1,
						},
					],
					example_arguments: { id: draft.id, chunk_index: 1 },
				},
			});
		}
		expect(await call("draft_append", chunk)).toEqual({
			...first,
			replayed: true,
		});
		const latest = await call("draft_append", {
			id: draft.id,
			chunk_index: 1,
			content: "\ntail\n",
		});
		await call("draft_finalize", {
			id: draft.id,
			chunk_count: latest.next_chunk_index,
			expected_sha256: latest.sha256,
		});
		await call("create_from_draft", {
			path: "large.txt",
			new_text_ref: draft.id,
		});
		expect(await readFile(join(dir, "large.txt"), "utf8")).toBe(
			chunk.content + "\ntail\n",
		);
	});
	it("keeps drafts isolated by agent and conversation", async () => {
		const dir = await workspace(),
			{ call } = family(dir),
			draft = await call("draft_create");
		await expect(
			call(
				"draft_append",
				{ id: draft.id, chunk_index: 0, content: "other" },
				{ ...context, conversationId: "another-conversation" },
			),
		).rejects.toThrow("not found");
		await expect(
			call(
				"draft_append",
				{ id: draft.id, chunk_index: 0, content: "other" },
				{ ...context, agentId: "another-agent" },
			),
		).rejects.toThrow("not found");
		await call("draft_append", {
			id: draft.id,
			chunk_index: 0,
			content: "ours",
		});
	});
	it("produces the exact proposed range content without touching the file", async () => {
		const dir = await workspace(),
			file = join(dir, "file.txt"),
			execute = createFileEditorExecutor();
		await writeFile(file, "\ufeffone\r\ntwo\r\nthree\r\n");
		const read = await execute("read_file", { path: file }, dir, context);
		const input = {
			path: file,
			new_text: "TWO",
			start_line: 2,
			end_line: 2,
			expected_sha256: read.sha256,
		};
		const preview = await execute(
			"preview",
			{ tool: "editor", arguments: input },
			dir,
			context,
		);
		expect(await readFile(file, "utf8")).toBe(preview.original_text);
		await execute("editor", input, dir, context);
		expect(await readFile(file, "utf8")).toBe(preview.new_text);
		expect(preview.new_text).toBe("\ufeffone\r\nTWO\r\nthree\r\n");
	});
	it("cancels while waiting for another writer and never commits after cancellation", async () => {
		const dir = await workspace(),
			file = join(dir, "file.txt"),
			lock = join(dir, ".file.txt.mcp-editor-lock"),
			{ call } = family(dir, 30);
		await writeFile(file, "original");
		await mkdir(lock);
		await expect(
			call("editor", { path: file, old_text: "original", new_text: "changed" }),
		).rejects.toThrow();
		await access(lock);
		await rm(lock, { recursive: true });
		await new Promise((accept) => setTimeout(accept, 80));
		expect(await readFile(file, "utf8")).toBe("original");
	});
	it("honors the grammar workaround without disabling runtime size checks", async () => {
		const dir = await workspace();
		vi.stubEnv("CLINE_GLOBAL_SETTINGS_PATH", join(dir, "settings.json"));
		await writeFile(
			join(dir, "settings.json"),
			JSON.stringify({
				fileEditor: { maxChars: 100, advertiseLengthBounds: false },
			}),
		);
		const { tools, call } = family(dir);
		const schema = tools.find((tool) => tool.name === "editor")!
			.inputSchema as { properties: { new_text: object } };
		expect(schema.properties.new_text).not.toHaveProperty("maxLength");
		await expect(
			call("editor", { path: "large.txt", new_text: "x".repeat(101) }),
		).rejects.toThrow("maximum is 100");
		await expect(access(join(dir, "large.txt"))).rejects.toThrow();
	});
	it("returns structured recovery on invalid arguments and never guesses missing content", async () => {
		const dir = await workspace(),
			{ call } = family(dir);
		try {
			await call("editor", { path: "missing.txt" });
			throw new Error("Expected rejection");
		} catch (error) {
			expect(JSON.parse((error as Error).message)).toMatchObject({
				success: false,
				code: "invalid_arguments",
				recovery: { tool: "editor", required_arguments: ["path", "new_text"] },
			});
		}
		await expect(access(join(dir, "missing.txt"))).rejects.toThrow();
	});
	it("keeps all editor operations unavailable in plan mode and disables the family as one unit", () => {
		const plan = createBuiltinTools({ enableEditor: false });
		expect(
			plan.some((tool) =>
				FILE_EDITOR_TOOL_NAMES.includes(
					tool.name as (typeof FILE_EDITOR_TOOL_NAMES)[number],
				),
			),
		).toBe(false);
		const enabled = createBuiltinTools();
		expect(
			filterDisabledTools(enabled, ["editor"]).some((tool) =>
				FILE_EDITOR_TOOL_NAMES.includes(
					tool.name as (typeof FILE_EDITOR_TOOL_NAMES)[number],
				),
			),
		).toBe(false);
	});
});
