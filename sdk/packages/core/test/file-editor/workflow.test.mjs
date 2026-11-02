import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDraftStore } from "../../src/extensions/tools/file-editor/engine/drafts.mjs";
import { createEditor } from "../../src/extensions/tools/file-editor/engine/editor.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
async function fixture(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "editor-workflow-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	return {
		root,
		file: path.join(root, "file.txt"),
		editor: await createEditor({ roots: [root] }),
	};
}

test("read returns exact bounded lines and a hash of full BOM/CRLF bytes", async (t) => {
	const { editor, file } = await fixture(t);
	const bytes = Buffer.from("\ufeffone\r\ntwo\r\nthree\r\n");
	await fs.writeFile(file, bytes);
	const read = await editor.read({
		path: file,
		start_line: 2,
		end_line: 3,
		max_chars: 5,
	});
	assert.equal(read.text, "two\r\n");
	assert.equal(read.sha256, sha(bytes));
	assert.equal(read.end_line, 2);
	assert.equal(read.line_count, 3);
	assert.equal(read.truncated, true);
	assert.equal(read.next_start_line, 3);
	await assert.rejects(editor.read({ path: file, start_line: 4 }), /outside/);
	await assert.rejects(
		editor.read({ path: file, max_chars: 2 }),
		/exceeds max_chars/,
	);
	await assert.rejects(
		editor.read({ path: file, max_chars: 50001 }),
		/exceed 50000/,
	);
});

test("line ranges preserve BOM and surrounding lines; empty replacement deletes whole lines", async (t) => {
	const { editor, file } = await fixture(t);
	await fs.writeFile(file, "\ufeffone\r\ntwo\r\nthree\r\n");
	let read = await editor.read({ path: file });
	const result = await editor.edit({
		path: file,
		start_line: 2,
		end_line: 2,
		new_text: '"new"\nnext',
		expected_sha256: read.sha256,
	});
	assert.equal(result.operation, "replace_lines");
	assert.equal(
		await fs.readFile(file, "utf8"),
		'\ufeffone\r\n"new"\r\nnext\r\nthree\r\n',
	);
	read = await editor.read({ path: file });
	await editor.edit({
		path: file,
		start_line: 2,
		end_line: 3,
		new_text: "",
		expected_sha256: read.sha256,
	});
	assert.equal(await fs.readFile(file, "utf8"), "\ufeffone\r\nthree\r\n");
});

test("EOF ranges retain existing newline and respect an explicit new newline", async (t) => {
	const { editor, file } = await fixture(t);
	for (const [before, replacement, expected] of [
		["a\nb", "c", "a\nc"],
		["a\nb\n", "c", "a\nc\n"],
		["a\nb", "c\n", "a\nc\n"],
		["a\nb\n", "", "a\n"],
		["a\r\rb\r", "c", "a\rc\r"],
	]) {
		await fs.writeFile(file, before);
		const read = await editor.read({ path: file });
		await editor.edit({
			path: file,
			start_line: 2,
			end_line: read.line_count,
			new_text: replacement,
			expected_sha256: read.sha256,
		});
		assert.equal(await fs.readFile(file, "utf8"), expected);
	}
});

test("empty-file read and insertion have explicit boundaries", async (t) => {
	const { editor, file } = await fixture(t);
	await fs.writeFile(file, "");
	const read = await editor.read({ path: file });
	assert.equal(read.text, "");
	assert.equal(read.start_line, 1);
	assert.equal(read.end_line, 0);
	assert.equal(read.line_count, 0);
	await assert.rejects(
		editor.edit({
			path: file,
			start_line: 1,
			end_line: 1,
			new_text: "x",
			expected_sha256: read.sha256,
		}),
		/empty file/,
	);
	await editor.edit({
		path: file,
		insert_line: 1,
		new_text: "x",
		expected_sha256: read.sha256,
	});
	assert.equal(await fs.readFile(file, "utf8"), "x");
});

test("range guards reject stale, missing, invalid and mixed selectors without writes", async (t) => {
	const { editor, file } = await fixture(t);
	await fs.writeFile(file, "one\ntwo\n");
	const read = await editor.read({ path: file });
	for (const args of [
		{ start_line: 1, end_line: 2 },
		{ start_line: 1, expected_sha256: read.sha256 },
		{ end_line: 1, expected_sha256: read.sha256 },
		{ start_line: 2, end_line: 1, expected_sha256: read.sha256 },
		{ start_line: 1, end_line: 3, expected_sha256: read.sha256 },
		{
			start_line: 1,
			end_line: 1,
			old_text: "one",
			expected_sha256: read.sha256,
		},
		{ start_line: 1, end_line: 1, append: true, expected_sha256: read.sha256 },
	]) {
		await assert.rejects(editor.edit({ path: file, new_text: "bad", ...args }));
		assert.equal(await fs.readFile(file, "utf8"), "one\ntwo\n");
	}
	await fs.writeFile(file, "inserted\none\ntwo\n");
	await assert.rejects(
		editor.edit({
			path: file,
			start_line: 1,
			end_line: 1,
			new_text: "bad",
			expected_sha256: read.sha256,
		}),
		/hash changed/,
	);
	assert.equal(await fs.readFile(file, "utf8"), "inserted\none\ntwo\n");
});

test("two queued ranges with the same hash cannot both edit shifted positions", async (t) => {
	const { editor, file } = await fixture(t);
	await fs.writeFile(file, "one\ntwo\n");
	const read = await editor.read({ path: file });
	const results = await Promise.allSettled(
		["first", "second"].map((new_text) =>
			editor.edit({
				path: file,
				start_line: 1,
				end_line: 1,
				new_text,
				expected_sha256: read.sha256,
			}),
		),
	);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	assert.match(
		results.find((r) => r.status === "rejected").reason.message,
		/hash changed/,
	);
});

test("read enforces roots without creating paths", async (t) => {
	const { editor, root } = await fixture(t);
	await assert.rejects(
		editor.read({ path: path.join(path.dirname(root), "outside", "file") }),
		/outside/,
	);
	await assert.rejects(editor.read({ path: "relative" }), /absolute/);
	await assert.rejects(
		editor.read({ path: path.join(root, "missing") }),
		/does not exist/,
	);
	assert.deepEqual(await fs.readdir(root), []);
});

test("no-match diagnostics are bounded hints and ambiguous matches identify lines", async (t) => {
	const { editor, file } = await fixture(t);
	const text = 'template: "value"\ntemplate: "value"\n';
	await fs.writeFile(file, text);
	await assert.rejects(
		editor.edit({ path: file, old_text: 'template: "value', new_text: "" }),
		(error) => error.diagnostics.match_lines.join(",") === "1,2",
	);
	await assert.rejects(
		editor.edit({ path: file, old_text: 'template: "valuue"', new_text: "" }),
		(error) =>
			error.diagnostics.candidates[0].line === 1 &&
			JSON.stringify(error.diagnostics).length < 2000,
	);
	assert.equal(await fs.readFile(file, "utf8"), text);
});

test("drafts acknowledge ordered chunks, retry safely, and finalize only an agreed hash/count", () => {
	const store = createDraftStore();
	const { id } = store.handle({ action: "create" });
	const first = store.handle({
		action: "append",
		id,
		chunk_index: 0,
		content: 'quoted "a"\n',
	});
	assert.equal(first.sha256, sha('quoted "a"\n'));
	const second = store.handle({
		action: "append",
		id,
		chunk_index: 1,
		content: "🙂\n",
	});
	assert.equal(second.sha256, sha('quoted "a"\n🙂\n'));
	assert.deepEqual(
		store.handle({
			action: "append",
			id,
			chunk_index: 0,
			content: 'quoted "a"\n',
		}),
		{ ...first, replayed: true },
	);
	assert.throws(
		() =>
			store.handle({
				action: "append",
				id,
				chunk_index: 0,
				content: "different",
			}),
		/different content/,
	);
	assert.throws(
		() =>
			store.handle({ action: "append", id, chunk_index: 3, content: "gap" }),
		/Out-of-order/,
	);
	assert.throws(() => store.resolve(id), /not finalized/);
	assert.throws(
		() =>
			store.handle({
				action: "finalize",
				id,
				chunk_count: 1,
				expected_sha256: second.sha256,
			}),
		/chunk_count/,
	);
	assert.throws(
		() =>
			store.handle({
				action: "finalize",
				id,
				chunk_count: 2,
				expected_sha256: first.sha256,
			}),
		/hash/,
	);
	store.handle({
		action: "finalize",
		id,
		chunk_count: 2,
		expected_sha256: second.sha256,
	});
	assert.equal(store.resolve(id), 'quoted "a"\n🙂\n');
	assert.throws(
		() =>
			store.handle({ action: "append", id, chunk_index: 2, content: "extra" }),
		/immutable/,
	);
	assert.throws(() => createDraftStore().resolve(id), /not found/);
});

test("draft limits and malformed chunks preserve acknowledged state", () => {
	const store = createDraftStore({ draftChunkChars: 10 });
	const created = store.handle({ action: "create" });
	for (const content of ["x".repeat(11), "\0", "\ud83d"])
		assert.throws(
			() =>
				store.handle({
					action: "append",
					id: created.id,
					chunk_index: 0,
					content,
				}),
			/Received 11 characters; maximum 10|content must/,
		);
	store.handle({
		action: "finalize",
		id: created.id,
		chunk_count: 0,
		expected_sha256: created.sha256,
	});
	assert.equal(store.resolve(created.id), "");
	for (let i = 0; i < 7; i++) store.handle({ action: "create" });
	assert.throws(() => store.handle({ action: "create" }), /8 drafts/);
	store.handle({ action: "discard", id: created.id });
	store.handle({ action: "discard", id: created.id });
	assert.throws(() => store.resolve(created.id), /not found/);
	assert.ok(store.handle({ action: "create" }).id);
});

test("draft chunk limits default to 8000 and can be configured above or below it", () => {
	for (const draftChunkChars of [undefined, 10, 12000]) {
		const limit = draftChunkChars ?? 8000;
		const store = createDraftStore({ draftChunkChars });
		const created = store.handle({ action: "create" });
		assert.equal(created.max_chunk_chars, limit);
		const content = "x".repeat(limit);
		const first = store.handle({
			action: "append",
			id: created.id,
			chunk_index: 0,
			content,
		});
		assert.equal(first.max_chunk_chars, limit);
		assert.throws(
			() =>
				store.handle({
					action: "append",
					id: created.id,
					chunk_index: 1,
					content: content + "x",
				}),
			(error) => {
				assert.equal(
					error.message,
					`Received ${limit + 1} characters; maximum ${limit}. Nothing was appended. Resend smaller chunks starting at index 1.`,
				);
				assert.deepEqual(error.diagnostics, {
					actual_chars: limit + 1,
					max_chunk_chars: limit,
					next_chunk_index: 1,
				});
				return true;
			},
		);
		assert.deepEqual(store.describe(), [
			{
				...created,
				sha256: sha(content),
				chars: limit,
				bytes: limit,
				next_chunk_index: 1,
				expires_at: first.expires_at,
			},
		]);
		store.handle({
			action: "finalize",
			id: created.id,
			chunk_count: 1,
			expected_sha256: first.sha256,
		});
		assert.equal(store.resolve(created.id), content);
	}
});

test("invalid chunk configuration is rejected before creating a draft store", () => {
	for (const draftChunkChars of [
		0,
		-1,
		1.5,
		NaN,
		Infinity,
		16777217,
		"8000",
		null,
	])
		assert.throws(
			() => createDraftStore({ draftChunkChars }),
			/draftChunkChars must be an integer between 1 and 16777216/,
		);
});

test("draft expiry uses idle time and releases slots", () => {
	let now = 0;
	const store = createDraftStore({ ttlMs: 1000, now: () => now });
	const created = store.handle({ action: "create" });
	now = 999;
	store.handle({
		action: "append",
		id: created.id,
		chunk_index: 0,
		content: "x",
	});
	now = 1500;
	store.handle({
		action: "finalize",
		id: created.id,
		chunk_count: 1,
		expected_sha256: sha("x"),
	});
	now = 2500;
	assert.throws(() => store.resolve(created.id), /expired/);
});

test("staged content above inline limit applies atomically after finalization and stale rejection", async (t) => {
	const { editor, file } = await fixture(t);
	await fs.writeFile(file, "before\n");
	const read = await editor.read({ path: file });
	const { id } = editor.draft({ action: "create" });
	const unit = "template: '{{ v if v.strip() != '''' else ''[]'' }}'\n";
	const chunks = Array.from({ length: 30 }, () => unit.repeat(40));
	let ack;
	for (const [chunk_index, content] of chunks.entries()) {
		ack = editor.draft({ action: "append", id, chunk_index, content });
		assert.equal(await fs.readFile(file, "utf8"), "before\n");
	}
	await assert.rejects(
		editor.edit({
			path: file,
			new_text_ref: id,
			start_line: 1,
			end_line: 1,
			expected_sha256: read.sha256,
		}),
		/not finalized/,
	);
	editor.draft({
		action: "finalize",
		id,
		chunk_count: chunks.length,
		expected_sha256: ack.sha256,
	});
	await fs.writeFile(file, "external\n");
	await assert.rejects(
		editor.edit({
			path: file,
			new_text_ref: id,
			start_line: 1,
			end_line: 1,
			expected_sha256: read.sha256,
		}),
		/hash changed/,
	);
	assert.equal(await fs.readFile(file, "utf8"), "external\n");
	const current = await editor.read({ path: file });
	const result = await editor.edit({
		path: file,
		new_text_ref: id,
		start_line: 1,
		end_line: 1,
		expected_sha256: current.sha256,
	});
	const expected = chunks.join("");
	assert.ok(expected.length > 50000);
	assert.equal(await fs.readFile(file, "utf8"), expected);
	assert.equal(result.sha256, sha(expected));
	await assert.rejects(
		editor.edit({ path: file, new_text: "x", new_text_ref: id }),
		/exactly one/,
	);
});
