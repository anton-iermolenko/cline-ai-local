import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	createEditor,
	lineCount,
} from "../../src/extensions/tools/file-editor/engine/editor.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, options = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-editor-test-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const editor = await createEditor({ roots: [root], ...options });
	return { root, editor, file: path.join(root, "file.txt") };
}

test("create and replace payloads well above 6K; exact saved content", async (t) => {
	const { editor, file } = await fixture(t);
	const text = "alpha\n".repeat(5000);
	const created = await editor.edit({ path: file, new_text: text });
	assert.equal(created.bytes, Buffer.byteLength(text));
	assert.equal(created.sha256, sha(text));
	assert.equal(await fs.readFile(file, "utf8"), text);
	assert.equal(created.diff.preview_truncated, true);
	assert.ok(JSON.stringify(created).length < 5000);
	const replacement = "beta\n".repeat(6000);
	const updated = await editor.edit({
		path: file,
		old_text: text,
		new_text: replacement,
	});
	assert.equal(await fs.readFile(file, "utf8"), replacement);
	assert.equal(updated.sha256, sha(replacement));
});

test("limit is configurable and schema matches validation", async (t) => {
	const { editor, file } = await fixture(t, { maxChars: 7000 });
	assert.equal(editor.tool.inputSchema.properties.new_text.maxLength, 7000);
	assert.match(editor.tool.description, /Maximum 7000/);
	await editor.edit({ path: file, new_text: "x".repeat(7000) });
	await assert.rejects(
		editor.edit({ path: file, old_text: "x".repeat(7001), new_text: "" }),
		/maximum is 7000/,
	);
	await assert.rejects(
		editor.edit({ path: file, new_text: "x".repeat(7001) }),
		/maximum is 7000/,
	);
	assert.equal((await fs.readFile(file)).length, 7000);
});

test("omitting advertised maxLength preserves runtime limits and failed-edit safety", async (t) => {
	const { editor, file } = await fixture(t, {
		maxChars: 7000,
		advertiseLengthBounds: false,
	});
	assert.equal(
		editor.tool.inputSchema.properties.new_text.maxLength,
		undefined,
	);
	assert.equal(
		editor.tool.inputSchema.properties.old_text.maxLength,
		undefined,
	);
	assert.match(editor.tool.description, /Maximum 7000/);
	assert.equal(editor.tool.inputSchema.additionalProperties, false);
	assert.equal(editor.tool.inputSchema.properties.path.minLength, 1);
	await editor.edit({ path: file, new_text: "x".repeat(7000) });
	await assert.rejects(
		editor.edit({ path: file, old_text: "x".repeat(7001), new_text: "" }),
		/maximum is 7000/,
	);
	await assert.rejects(
		editor.edit({
			path: file,
			old_text: "x".repeat(7000),
			new_text: "y".repeat(7001),
		}),
		/maximum is 7000/,
	);
	assert.equal(await fs.readFile(file, "utf8"), "x".repeat(7000));
});

test("missing files accept omitted, null, or empty old_text in previews and writes", async (t) => {
	const { editor, root } = await fixture(t);
	for (const [index, args] of [
		{},
		{ old_text: null },
		{ old_text: "" },
	].entries()) {
		for (const text of ["created\n", ""]) {
			const file = path.join(root, `${index}-${text.length}.txt`);
			const input = { path: file, new_text: text, ...args };
			const preview = await editor.preview("editor", input);
			assert.equal(preview.operation, "create");
			assert.equal(preview.original_text, "");
			assert.equal(preview.new_text, text);
			await assert.rejects(fs.access(file), { code: "ENOENT" });
			const created = await editor.call("editor", input);
			assert.equal(created.operation, "create");
			assert.equal(created.sha256, sha(text));
			assert.equal(await fs.readFile(file, "utf8"), text);
		}
	}
});

test("missing files still reject replacement text and edit selectors", async (t) => {
	const { editor, file } = await fixture(t);
	for (const args of [
		{ old_text: "existing text" },
		{ old_text: " " },
		{ old_text: "", insert_line: 1 },
		{ old_text: "", append: true },
	]) {
		const input = { path: file, new_text: "oops", ...args };
		const expected = /File does not exist|Choose one of/;
		await assert.rejects(editor.preview("editor", input), expected);
		await assert.rejects(editor.call("editor", input), expected);
		await assert.rejects(fs.access(file), { code: "ENOENT" });
	}
});

test("existing file is never overwritten by omitted/null/empty old_text", async (t) => {
	const { editor, file } = await fixture(t);
	for (const text of ["preserve", ""]) {
		await fs.writeFile(file, text);
		for (const args of [{}, { old_text: null }, { old_text: "" }]) {
			const input = { path: file, new_text: "oops", ...args };
			await assert.rejects(
				editor.preview("editor", input),
				/Existing file requires/,
			);
			await assert.rejects(editor.edit(input), /Existing file requires/);
			assert.equal(await fs.readFile(file, "utf8"), text);
		}
	}
});

test("missing and ambiguous replacements preserve originals; queue recovers", async (t) => {
	const { editor, file } = await fixture(t);
	await fs.writeFile(file, "hello hello");
	await assert.rejects(
		editor.edit({ path: file, old_text: "absent", new_text: "oops" }),
		/not found/,
	);
	await assert.rejects(
		editor.edit({ path: file, old_text: "hello", new_text: "oops" }),
		/more than once/,
	);
	assert.equal(await fs.readFile(file, "utf8"), "hello hello");
	await editor.edit({ path: file, old_text: "hello hello", new_text: "okay" });
	assert.equal(await fs.readFile(file, "utf8"), "okay");
});

test("literal dollars and empty replacements", async (t) => {
	const { editor, file } = await fixture(t);
	await fs.writeFile(file, "left target right");
	const literal = "$& $' $" + String.fromCharCode(96) + " $$ $1";
	await editor.edit({ path: file, old_text: "target", new_text: literal });
	assert.equal(await fs.readFile(file, "utf8"), "left " + literal + " right");
	await editor.edit({ path: file, old_text: literal, new_text: "" });
	assert.equal(await fs.readFile(file, "utf8"), "left  right");
});

test("overlapping duplicate matches are rejected", async (t) => {
	const { editor, file } = await fixture(t);
	await fs.writeFile(file, "aaa");
	await assert.rejects(
		editor.edit({ path: file, old_text: "aa", new_text: "b" }),
		/more than once/,
	);
	assert.equal(await fs.readFile(file, "utf8"), "aaa");
});

test("BOM, CRLF and non-ASCII characters survive edits", async (t) => {
	const { editor, file } = await fixture(t);
	const bom = Buffer.from([0xef, 0xbb, 0xbf]);
	await fs.writeFile(
		file,
		Buffer.concat([bom, Buffer.from("café\r\nQwen\r\n")]),
	);
	await editor.edit({
		path: file,
		old_text: "café\nQwen\n",
		new_text: "日本語\n🙂\n",
	});
	assert.deepEqual(
		await fs.readFile(file),
		Buffer.concat([bom, Buffer.from("日本語\r\n🙂\r\n")]),
	);
	await editor.edit({ path: file, append: true, new_text: "last\n" });
	assert.deepEqual(
		await fs.readFile(file),
		Buffer.concat([bom, Buffer.from("日本語\r\n🙂\r\nlast\r\n")]),
	);
});

test("line insertion handles trailing newline without adding a blank line", async (t) => {
	const { editor, file } = await fixture(t);
	await fs.writeFile(file, "one\ntwo\n");
	await editor.edit({ path: file, insert_line: "2", new_text: "middle\n" });
	assert.equal(await fs.readFile(file, "utf8"), "one\nmiddle\ntwo\n");
	await editor.edit({ path: file, insert_line: 4, new_text: "last\n" });
	assert.equal(await fs.readFile(file, "utf8"), "one\nmiddle\ntwo\nlast\n");
	await assert.rejects(
		editor.edit({ path: file, insert_line: 6, new_text: "bad" }),
		/1-5/,
	);
});

test("EOF insertion, empty files, and verbatim append have clear semantics", async (t) => {
	const { editor, file } = await fixture(t);
	await editor.edit({ path: file, new_text: "" });
	await editor.edit({ path: file, insert_line: 1, new_text: "one" });
	await editor.edit({ path: file, append: true, new_text: "tail" });
	assert.equal(await fs.readFile(file, "utf8"), "onetail");
	await editor.edit({ path: file, insert_line: 2, new_text: "two" });
	assert.equal(await fs.readFile(file, "utf8"), "onetail\ntwo");
	assert.equal(lineCount(""), 0);
	assert.equal(lineCount("x\n"), 1);
	assert.equal(lineCount("x\r\n\r\n"), 2);
});

test("same-process concurrent appends have no lost writes", async (t) => {
	const { editor, file } = await fixture(t);
	await editor.edit({ path: file, new_text: "" });
	await Promise.all(
		Array.from({ length: 30 }, (_, i) =>
			editor.edit({ path: file, append: true, new_text: i + "\n" }),
		),
	);
	const lines = (await fs.readFile(file, "utf8"))
		.trim()
		.split("\n")
		.map(Number)
		.sort((a, b) => a - b);
	assert.deepEqual(
		lines,
		Array.from({ length: 30 }, (_, i) => i),
	);
});

test("different editor instances coordinate via the filesystem lock", async (t) => {
	const { editor, file, root } = await fixture(t);
	const other = await createEditor({ roots: [root] });
	await editor.edit({ path: file, new_text: "" });
	await Promise.all(
		Array.from({ length: 20 }, (_, i) =>
			(i % 2 ? editor : other).edit({
				path: file,
				append: true,
				new_text: i + "\n",
			}),
		),
	);
	assert.equal((await fs.readFile(file, "utf8")).trim().split("\n").length, 20);
	assert.deepEqual(await fs.readdir(root), ["file.txt"]);
});

test("optimistic hashes reject a stale edit", async (t) => {
	const { editor, file } = await fixture(t);
	const original = await editor.edit({ path: file, new_text: "one" });
	await editor.edit({
		path: file,
		old_text: "one",
		new_text: "two",
		expected_sha256: original.sha256,
	});
	await assert.rejects(
		editor.edit({
			path: file,
			old_text: "two",
			new_text: "three",
			expected_sha256: original.sha256,
		}),
		/hash changed/,
	);
	assert.equal(await fs.readFile(file, "utf8"), "two");
});

test("binary and malformed UTF-8 are not silently rewritten", async (t) => {
	const { editor, file } = await fixture(t);
	for (const bytes of [Buffer.from([0, 1, 2]), Buffer.from([0xc3, 0x28])]) {
		await fs.writeFile(file, bytes);
		await assert.rejects(
			editor.edit({ path: file, append: true, new_text: "bad" }),
		);
		assert.deepEqual(await fs.readFile(file), bytes);
	}
});

test("root enforcement precedes creation of outside directories", async (t) => {
	const { editor, root } = await fixture(t);
	const outside = path.join(
		path.dirname(root),
		path.basename(root) + "-outside",
		"file",
	);
	await assert.rejects(
		editor.edit({ path: outside, new_text: "bad" }),
		/outside/,
	);
	await assert.rejects(fs.stat(path.dirname(outside)), { code: "ENOENT" });
	await assert.rejects(
		editor.edit({ path: "relative.txt", new_text: "bad" }),
		/absolute/,
	);
});

test("invalid/mixed arguments fail without writing", async (t) => {
	const { editor, file } = await fixture(t);
	for (const extra of [
		{ append: "true" },
		{ insert_line: true },
		{ insert_line: 0 },
		{ insert_line: 1.2 },
		{ insert_line: 1, old_text: "a" },
		{ append: true, old_text: "a" },
		{ expected_sha256: "bad" },
		{ unknown: "x" },
	]) {
		await assert.rejects(
			editor.edit({ path: file, new_text: "bad", ...extra }),
		);
		await assert.rejects(fs.stat(file), { code: "ENOENT" });
	}
});

test("lock timeout preserves the original and never removes another lock", async (t) => {
	const { editor, file, root } = await fixture(t, { lockTimeoutMs: 50 });
	await fs.writeFile(file, "one");
	const lock = path.join(root, ".file.txt.mcp-editor-lock");
	await fs.mkdir(lock);
	await assert.rejects(
		editor.edit({ path: file, old_text: "one", new_text: "bad" }),
		/File is locked/,
	);
	assert.equal(await fs.readFile(file, "utf8"), "one");
	assert.ok((await fs.stat(lock)).isDirectory());
});

test("unchanged edits do not replace the file", async (t) => {
	const { editor, file } = await fixture(t);
	await editor.edit({ path: file, new_text: "one" });
	const stat = await fs.stat(file);
	const result = await editor.edit({
		path: file,
		old_text: "one",
		new_text: "one",
	});
	assert.equal(result.changed, false);
	assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
});

test("symlinks resolve to one target and cannot escape roots", {
	skip: process.platform === "win32",
}, async (t) => {
	const { editor, file, root } = await fixture(t);
	await fs.writeFile(file, "one");
	const alias = path.join(root, "alias.txt");
	await fs.symlink(file, alias);
	await editor.edit({ path: alias, old_text: "one", new_text: "two" });
	assert.equal(await fs.readFile(file, "utf8"), "two");
	assert.ok((await fs.lstat(alias)).isSymbolicLink());
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), "editor-outside-"));
	t.after(() => fs.rm(outside, { recursive: true, force: true }));
	const outsideLink = path.join(root, "escape");
	await fs.symlink(outside, outsideLink);
	await assert.rejects(
		editor.edit({ path: path.join(outsideLink, "bad"), new_text: "bad" }),
		/outside/,
	);
});

test("POSIX file modes are preserved", {
	skip: process.platform === "win32",
}, async (t) => {
	const { editor, file } = await fixture(t);
	await fs.writeFile(file, "#!/bin/sh\nold\n", { mode: 0o755 });
	await editor.edit({ path: file, old_text: "old", new_text: "new" });
	assert.equal((await fs.stat(file)).mode & 0o777, 0o755);
});
