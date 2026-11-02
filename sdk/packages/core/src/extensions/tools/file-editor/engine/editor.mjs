import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateArguments } from "./contracts.mjs";
import { createDraftStore } from "./drafts.mjs";

export const DEFAULT_MAX_CHARS = 50_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function positiveInteger(value, fallback, name) {
	if (value === undefined) return fallback;
	if (
		(typeof value !== "string" && typeof value !== "number") ||
		!String(value).match(/^\d+$/)
	)
		throw Error(name + " must be a positive integer.");
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 1)
		throw Error(name + " must be a positive integer.");
	return number;
}

export function editorTool(
	maxChars = DEFAULT_MAX_CHARS,
	advertiseLengthBounds = true,
) {
	return {
		name: "editor",
		description:
			'Edit with inline text. REQUIRED on EVERY call: path AND new_text, including new_text="" for deliberate deletion. Create a missing UTF-8 file, replace one exact old_text match, replace an inclusive line range, insert, or append. Maximum ' +
			maxChars +
			" characters EACH in old_text and new_text; this ceiling does not increase the model output budget. For quote-heavy replacements read_file then use start_line/end_line with its sha256 as expected_sha256. For staged content use apply_draft instead. Existing files are never overwritten by omission. Send dependent edits sequentially.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["path", "new_text"],
			properties: {
				path: {
					type: "string",
					minLength: 1,
					description:
						"Absolute file path. On WSL, Windows drive and Ubuntu WSL UNC paths are accepted too.",
				},
				new_text: {
					type: "string",
					...(advertiseLengthBounds ? { maxLength: maxChars } : {}),
					description:
						"Content for creation, replacement, insertion, or append. Empty replacement deletes old_text.",
				},
				old_text: {
					type: ["string", "null"],
					...(advertiseLengthBounds ? { maxLength: maxChars } : {}),
					description:
						"Exact text to replace; must match exactly once. Read first. Omit for creation, insertion, or append.",
				},
				insert_line: {
					type: ["integer", "string", "null"],
					description:
						"Insert before this one-based line, or line_count+1 at EOF. A trailing newline is not an extra line. Prefer append=true at EOF.",
				},
				append: {
					type: "boolean",
					description:
						"Append new_text to an existing file, without an implicit newline separator.",
				},
				start_line: {
					type: "integer",
					minimum: 1,
					description:
						"Replace from this one-based line, inclusive. Requires end_line and expected_sha256 from read_file.",
				},
				end_line: {
					type: "integer",
					minimum: 0,
					description:
						"Last line to replace, inclusive. Use 0 ONLY with start_line=1 for a verified empty file. Empty new_text deletes selected lines.",
				},
				expected_sha256: {
					type: "string",
					pattern: "^[a-fA-F0-9]{64}$",
					description:
						"Optional expected SHA-256 of current file bytes. Reject without writing if mismatched.",
				},
			},
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
	};
}

function applyDraftTool(maxChars, advertiseLengthBounds) {
	const inline = editorTool(maxChars, advertiseLengthBounds);
	const { path, start_line, end_line, expected_sha256 } =
		inline.inputSchema.properties;
	return {
		...inline,
		name: "apply_draft",
		description:
			"Replace an inclusive line range in an EXISTING file with finalized staged content, atomically. ALL FIVE arguments are REQUIRED: path, new_text_ref, start_line, end_line, expected_sha256. Use read_file first and copy its sha256; choose actual one-based inclusive bounds (1 through line_count replaces the whole file; an empty file uses start_line=1,end_line=0). For a MISSING file use create_from_draft instead. Do not send inline new_text or old_text. Read back and validate the result.",
		inputSchema: {
			...inline.inputSchema,
			required: [
				"path",
				"new_text_ref",
				"start_line",
				"end_line",
				"expected_sha256",
			],
			properties: {
				path,
				new_text_ref: {
					type: "string",
					minLength: 1,
					description: "EXACT id of a successfully finalized draft.",
				},
				start_line,
				end_line,
				expected_sha256,
			},
		},
	};
}

function createFromDraftTool(maxChars, advertiseLengthBounds) {
	const replacement = applyDraftTool(maxChars, advertiseLengthBounds);
	return {
		...replacement,
		name: "create_from_draft",
		description:
			"Create a MISSING UTF-8 file from a finalized draft. REQUIRED: path and new_text_ref (the finalized draft id). Never overwrites an existing file; for an existing file read_file first, then use apply_draft with the range and file hash. Drafts are local to this editor session.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["path", "new_text_ref"],
			properties: {
				path: replacement.inputSchema.properties.path,
				new_text_ref: replacement.inputSchema.properties.new_text_ref,
			},
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
	};
}

function readTool() {
	return {
		name: "read_file",
		description:
			"Read exact UTF-8 text and the SHA-256 of the SAME full-file byte snapshot for safe positional edits. Returns unnumbered text, actual one-based inclusive line bounds and full-file line_count. Default output cap is 12000 characters; request smaller ranges for focused inspection. If output is capped, use the returned bounds and next_start_line; never assume the requested end_line was returned. Empty files return start_line=1,end_line=0. Use sha256 as editor.expected_sha256.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["path"],
			properties: {
				path: { type: "string", minLength: 1 },
				start_line: { type: "integer", minimum: 1 },
				end_line: { type: "integer", minimum: 1 },
				max_chars: { type: "integer", minimum: 1, maximum: 50000 },
			},
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
	};
}

function lineBoundaries(text) {
	const offsets = [0];
	for (const match of text.matchAll(/\r\n|\r|\n/g))
		offsets.push(match.index + match[0].length);
	if (offsets.at(-1) !== text.length) offsets.push(text.length);
	return offsets;
}

function noMatchError(text, needle) {
	const expected = needle.split(/\r\n|\r|\n/)[0].slice(0, 256);
	const candidates = [];
	let line = 0;
	// Bounded hints only: never use approximate candidates to perform a write.
	for (const match of text
		.slice(0, 256000)
		.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
		if (!match[0] || ++line > 2000) break;
		const actual = match[0].replace(/[\r\n]+$/, "").slice(0, 256);
		let score = 0;
		while (
			score < Math.min(actual.length, expected.length) &&
			actual[score] === expected[score]
		)
			score++;
		if (score >= 8) candidates.push({ line, score, actual });
	}
	candidates.sort((a, b) => b.score - a.score);
	const error = Error(
		"old_text was not found. Read the current file and use an exact match, or read_file then a hash-guarded line range; no write performed.",
	);
	error.diagnostics = {
		expected_first_line: expected,
		candidates: candidates.slice(0, 3),
		search_bounded: true,
	};
	return error;
}

function hostPath(input) {
	if (typeof input !== "string" || !input.trim() || input.includes("\0"))
		throw Error("path must be a nonempty absolute file path.");
	if (process.platform === "linux") {
		if (/^[A-Za-z]:[\\/]/.test(input))
			return (
				"/mnt/" +
				input[0].toLowerCase() +
				"/" +
				input.slice(3).replaceAll("\\", "/")
			);
		const unc = input
			.replaceAll("\\", "/")
			.match(/^\/\/wsl(?:\.localhost|\$)\/Ubuntu\/(.*)$/i);
		if (unc) return "/" + unc[1];
	}
	if (!path.isAbsolute(input))
		throw Error(
			"path must be absolute; use an absolute path or resolve it against the workspace.",
		);
	return path.resolve(input);
}

async function canonicalPath(input) {
	let current = hostPath(input);
	const missing = [];
	while (true) {
		try {
			const real = await fs.realpath(current);
			return path.join(real, ...missing.reverse());
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			// Do not treat dangling symlinks as missing ordinary files.
			try {
				const stat = await fs.lstat(current);
				if (stat.isSymbolicLink())
					throw Error("Dangling symbolic link: " + current);
			} catch (statError) {
				if (statError.code !== "ENOENT") throw statError;
			}
			const parent = path.dirname(current);
			if (parent === current) throw error;
			missing.push(path.basename(current));
			current = parent;
		}
	}
}

function inside(root, target) {
	const relative = path.relative(root, target);
	return (
		relative === "" ||
		(!path.isAbsolute(relative) &&
			relative !== ".." &&
			!relative.startsWith(".." + path.sep))
	);
}

async function snapshot(file) {
	try {
		const stat = await fs.stat(file);
		if (!stat.isFile()) throw Error("Target must be a regular text file.");
		if (stat.size > MAX_FILE_BYTES)
			throw Error("File exceeds the 16 MiB text-file limit.");
		if (stat.nlink > 1)
			throw Error("Refusing atomic replacement of a hard-linked file.");
		const bytes = await fs.readFile(file);
		if (bytes.length > MAX_FILE_BYTES)
			throw Error("File exceeds the 16 MiB text-file limit.");
		const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
		const text = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: true,
		}).decode(bom ? bytes.subarray(3) : bytes);
		if (text.includes("\0"))
			throw Error("Binary/NUL content is not supported.");
		return { bytes, text, bom, mode: stat.mode, sha256: hash(bytes) };
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

const eolFor = (text) =>
	text.includes("\r\n")
		? "\r\n"
		: text.includes("\r") && !text.includes("\n")
			? "\r"
			: "\n";
const normalize = (text, eol) => text.replace(/\r\n|\r|\n/g, eol);
export const lineCount = (text) =>
	text === ""
		? 0
		: text.split(/\r\n|\r|\n/).length - (/[\r\n]$/.test(text) ? 1 : 0);

function updatedText(before, input) {
	if (!before) {
		if (
			input.old_text != null ||
			input.insert_line != null ||
			input.start_line != null ||
			input.append ||
			input.expected_sha256
		)
			throw Error(
				"File does not exist. Create it with path and new_text or new_text_ref only.",
			);
		return { text: input.new_text, operation: "create" };
	}
	const eol = eolFor(before.text);
	const replacement = normalize(input.new_text, eol);
	if (input.start_line != null) {
		const boundaries = lineBoundaries(before.text),
			count = boundaries.length - 1;
		if (input.end_line === 0) {
			if (count !== 0 || input.start_line !== 1)
				throw Error(
					"The 1-0 range is only valid for a verified empty file; no write performed.",
				);
			return { text: replacement, operation: "replace_lines" };
		}
		if (input.end_line > count)
			throw Error(
				"Line range must be within 1-" +
					count +
					". For an empty file use insert_line=1 or append=true.",
			);
		const start = boundaries[input.start_line - 1],
			end = boundaries[input.end_line];
		const needsSeparator =
			replacement &&
			!/[\r\n]$/.test(replacement) &&
			(end < before.text.length || /[\r\n]$/.test(before.text));
		return {
			text:
				before.text.slice(0, start) +
				replacement +
				(needsSeparator ? eol : "") +
				before.text.slice(end),
			operation: "replace_lines",
		};
	}
	if (input.append)
		return { text: before.text + replacement, operation: "append" };
	if (input.insert_line != null) {
		const count = lineCount(before.text),
			boundary = input.insert_line;
		if (boundary > count + 1)
			throw Error(
				"insert_line must be in 1-" + (count + 1) + "; use append=true at EOF.",
			);
		if (!replacement) return { text: before.text, operation: "insert" };
		// Slice at real boundaries, avoiding split/splice's phantom trailing line.
		if (boundary === count + 1) {
			const separator = before.text && !/[\r\n]$/.test(before.text) ? eol : "";
			return {
				text: before.text + separator + replacement,
				operation: "insert",
			};
		}
		let offset = 0;
		const breaks = before.text.matchAll(/\r\n|\r|\n/g);
		for (let line = 1; line < boundary; line++) {
			const entry = breaks.next().value;
			offset = entry.index + entry[0].length;
		}
		const separator = /[\r\n]$/.test(replacement) ? "" : eol;
		return {
			text:
				before.text.slice(0, offset) +
				replacement +
				separator +
				before.text.slice(offset),
			operation: "insert",
		};
	}
	if (!input.old_text)
		throw Error(
			input.new_text_ref
				? "Target already exists. Use read_file, then apply_draft with path, new_text_ref, start_line, end_line and expected_sha256; no write performed."
				: "Existing file requires nonempty old_text (exactly one match), insert_line, or append=true. Read first; do not resend the unchanged call.",
		);
	const needle = normalize(input.old_text, eol);
	const first = before.text.indexOf(needle);
	if (first < 0) throw noMatchError(before.text, needle);
	const second = before.text.indexOf(needle, first + 1);
	if (second >= 0) {
		const error = Error(
			"old_text matches more than once. Include surrounding text, or use read_file and a hash-guarded line range; no write performed.",
		);
		error.diagnostics = {
			match_lines: [first, second].map(
				(offset) => before.text.slice(0, offset).split(/\r\n|\r|\n/).length,
			),
		};
		throw error;
	}
	return {
		text:
			before.text.slice(0, first) +
			replacement +
			before.text.slice(first + needle.length),
		operation: "replace",
	};
}

function diffSummary(oldText, newText) {
	const oldLines = oldText.split(/\r\n|\r|\n/),
		newLines = newText.split(/\r\n|\r|\n/);
	let start = 0,
		oldEnd = oldLines.length,
		newEnd = newLines.length;
	while (
		start < oldEnd &&
		start < newEnd &&
		oldLines[start] === newLines[start]
	)
		start++;
	while (
		oldEnd > start &&
		newEnd > start &&
		oldLines[oldEnd - 1] === newLines[newEnd - 1]
	) {
		oldEnd--;
		newEnd--;
	}
	let preview = "",
		shown = 0;
	const add = (prefix, lines, end) => {
		for (let index = start; index < end; index++) {
			const entry = prefix + (index + 1) + ": " + lines[index] + "\n";
			if (shown >= 40 || preview.length + entry.length > 3000) return;
			preview += entry;
			shown++;
		}
	};
	add("-", oldLines, oldEnd);
	add("+", newLines, newEnd);
	return {
		removed_lines: oldEnd - start,
		added_lines: newEnd - start,
		preview,
		preview_truncated: shown < oldEnd + newEnd - 2 * start,
	};
}

export function fileEditorToolDefinitions(
	maxChars = DEFAULT_MAX_CHARS,
	advertiseLengthBounds = true,
	draftChunkChars,
) {
	return [
		editorTool(maxChars, advertiseLengthBounds),
		readTool(),
		applyDraftTool(maxChars, advertiseLengthBounds),
		createFromDraftTool(maxChars, advertiseLengthBounds),
		...createDraftStore({ draftChunkChars }).tools,
	];
}

export async function createEditor(options = {}) {
	const maxChars = positiveInteger(
		options.maxChars,
		DEFAULT_MAX_CHARS,
		"maxChars",
	);
	const advertiseLengthBounds = options.advertiseLengthBounds ?? true;
	if (typeof advertiseLengthBounds !== "boolean")
		throw Error("advertiseLengthBounds must be boolean.");
	const lockTimeoutMs = positiveInteger(
		options.lockTimeoutMs,
		15_000,
		"lockTimeoutMs",
	);
	const roots = await Promise.all((options.roots ?? []).map(canonicalPath));
	const queues = new Map();
	const drafts = createDraftStore({ draftChunkChars: options.draftChunkChars });
	const tools = fileEditorToolDefinitions(
		maxChars,
		advertiseLengthBounds,
		options.draftChunkChars,
	);
	const properties = {
		...editorTool(maxChars).inputSchema.properties,
		new_text_ref: { type: "string" },
	};

	function validate(input) {
		for (const key of Object.keys(input))
			if (!Object.hasOwn(properties, key))
				throw Error("Unknown editor argument: " + key);
		if (
			Object.hasOwn(input, "new_text") === Object.hasOwn(input, "new_text_ref")
		)
			throw Error("Supply exactly one of new_text or new_text_ref.");
		if (
			Object.hasOwn(input, "new_text_ref") &&
			(typeof input.new_text_ref !== "string" || !input.new_text_ref)
		)
			throw Error("new_text_ref must be a finalized draft id.");
		for (const key of ["new_text", "old_text"]) {
			if (key === "new_text" && input.new_text_ref !== undefined) continue;
			if (key === "old_text" && input[key] == null) continue;
			if (typeof input[key] !== "string")
				throw Error(key + " must be a string.");
			if (input[key].length > maxChars)
				throw Error(
					key +
						" has " +
						input[key].length +
						" characters; maximum is " +
						maxChars +
						". Split sequentially, preserving all content.",
				);
			if (input[key].includes("\0"))
				throw Error(key + " must not contain NUL characters.");
		}
		if (input.append !== undefined && typeof input.append !== "boolean")
			throw Error("append must be a boolean.");
		if (input.insert_line != null)
			input.insert_line = positiveInteger(
				input.insert_line,
				undefined,
				"insert_line",
			);
		const range =
			input.start_line !== undefined || input.end_line !== undefined;
		if (range) {
			input.start_line = positiveInteger(
				input.start_line,
				undefined,
				"start_line",
			);
			input.end_line =
				input.end_line === 0
					? 0
					: positiveInteger(input.end_line, undefined, "end_line");
			const emptyRange = input.start_line === 1 && input.end_line === 0;
			if (
				!input.start_line ||
				input.end_line === undefined ||
				(input.end_line < input.start_line && !emptyRange)
			)
				throw Error(
					"Provide start_line and end_line with 1 <= start_line <= end_line (or 1-0 only for an empty file).",
				);
			if (!input.expected_sha256)
				throw Error(
					"Line-range edits require expected_sha256 from read_file. Read the file before editing.",
				);
		}
		const modes =
			Number(input.old_text != null) +
			Number(input.insert_line != null) +
			Number(input.append === true) +
			Number(range);
		if (modes > 1)
			throw Error(
				"Choose one of old_text, start_line/end_line, insert_line, or append=true.",
			);
		if (
			input.expected_sha256 !== undefined &&
			(typeof input.expected_sha256 !== "string" ||
				!/^[a-fA-F0-9]{64}$/.test(input.expected_sha256))
		)
			throw Error("expected_sha256 must be 64 hexadecimal characters.");
	}

	async function execute(file, input, signal) {
		signal?.throwIfAborted();
		if (roots.length && !roots.some((root) => inside(root, file)))
			throw Error("Path is outside the configured editor roots.");
		await fs.mkdir(path.dirname(file), { recursive: true });
		if ((await canonicalPath(file)) !== file)
			throw Error("Path changed during resolution; inspect and retry.");
		// Same adjacent lock is used by separate MCP processes (CLI and extension).
		const lock = path.join(
			path.dirname(file),
			"." + path.basename(file) + ".mcp-editor-lock",
		);
		const deadline = Date.now() + lockTimeoutMs;
		while (true) {
			signal?.throwIfAborted();
			try {
				await fs.mkdir(lock, { mode: 0o700 });
				break;
			} catch (error) {
				if (error.code !== "EEXIST") throw error;
				if (Date.now() >= deadline)
					throw Error(
						"File is locked: " +
							lock +
							". Wait for completion. After a crash, inspect the file and remove this lock directory manually only when no editor call is active.",
					);
				await delay(25, undefined, { signal });
			}
		}
		let temporary;
		try {
			signal?.throwIfAborted();
			const before = await snapshot(file);
			if (
				input.expected_sha256 &&
				before?.sha256 !== input.expected_sha256.toLowerCase()
			)
				throw Error(
					"File hash changed; no write performed. Read before retrying.",
				);
			const { text, operation } = updatedText(before, input);
			const bytes = Buffer.concat([
				before?.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
				Buffer.from(text, "utf8"),
			]);
			if (bytes.length > MAX_FILE_BYTES)
				throw Error("Result exceeds the 16 MiB text-file limit.");
			const sha256 = hash(bytes),
				changed = sha256 !== before?.sha256;
			if (changed) {
				temporary = path.join(
					path.dirname(file),
					"." + path.basename(file) + "." + randomUUID() + ".mcp-editor.tmp",
				);
				const handle = await fs.open(
					temporary,
					"wx",
					before ? before.mode & 0o777 : 0o666,
				);
				try {
					await handle.writeFile(bytes);
					await handle.sync();
				} finally {
					await handle.close();
				}
				if (before) await fs.chmod(temporary, before.mode & 0o777);
				if ((await canonicalPath(file)) !== file)
					throw Error("Path changed before commit; no write performed.");
				const current = await snapshot(file);
				if (current?.sha256 !== before?.sha256)
					throw Error(
						"File changed during edit; no write performed. Read and retry.",
					);
				signal?.throwIfAborted();
				if (before) await fs.rename(temporary, file);
				else await fs.link(temporary, file); // Exclusive create: never clobber a newly appeared file.
				await fs.unlink(temporary).catch((error) => {
					if (error.code !== "ENOENT") throw error;
				});
				temporary = undefined;
			}
			return {
				success: true,
				path: file,
				operation,
				changed,
				bytes: bytes.length,
				sha256,
				line_count: lineCount(text),
				diff: diffSummary(before?.text ?? "", text),
			};
		} finally {
			if (temporary) await fs.unlink(temporary).catch(() => {});
			await fs.rmdir(lock);
		}
	}

	const api = {
		tool: editorTool(maxChars, advertiseLengthBounds),
		tools,
		draft: drafts.handle,
		async call(name, arguments_ = {}, signal) {
			signal?.throwIfAborted();
			const legacyAction =
				name === "draft" && arguments_ && typeof arguments_ === "object"
					? arguments_.action
					: undefined;
			const legacyReference =
				name === "editor" &&
				arguments_ &&
				typeof arguments_ === "object" &&
				Object.hasOwn(arguments_, "new_text_ref") &&
				!Object.hasOwn(arguments_, "new_text");
			const requested = legacyReference
				? "apply_draft"
				: legacyAction &&
						["create", "append", "finalize", "discard"].includes(legacyAction)
					? "draft_" + legacyAction
					: name;
			const tool = tools.find((tool) => tool.name === requested);
			try {
				if (!tool || legacyAction)
					throw Error(
						name === "draft"
							? "The combined draft tool was replaced. Use draft_create, draft_append, draft_finalize or draft_discard, with their required arguments; omit action."
							: "Unknown tool. Available tools: " +
									tools.map((tool) => tool.name).join(", "),
					);
				if (legacyReference)
					throw Error(
						"Staged content now uses apply_draft with the file range/hash, or create_from_draft for a missing file. Do not invent inline new_text.",
					);
				validateArguments(tool, arguments_);
				if (
					name === "editor" ||
					name === "apply_draft" ||
					name === "create_from_draft"
				)
					return await api.edit(arguments_, signal);
				if (name === "read_file") return await api.read(arguments_, signal);
				return drafts.handle({
					...arguments_,
					action: name.slice("draft_".length),
				});
			} catch (error) {
				if (tool) {
					const input =
						arguments_ && typeof arguments_ === "object" ? arguments_ : {};
					const active = requested.startsWith("draft_")
						? drafts.describe()
						: [];
					const draft =
						active.find((draft) => draft.id === input.id) ??
						(active.length === 1 ? active[0] : undefined);
					const id = draft?.id ?? input.id ?? "<copy draft_create.id>";
					const selector = Object.fromEntries(
						[
							"old_text",
							"insert_line",
							"append",
							"start_line",
							"end_line",
							"expected_sha256",
						]
							.filter(
								(key) =>
									Object.hasOwn(input, key) &&
									Object.hasOwn(tool.inputSchema.properties, key),
							)
							.map((key) => [
								key,
								key === "old_text" &&
								typeof input[key] === "string" &&
								input[key].length > 1000
									? "<resend your exact old_text>"
									: input[key],
							]),
					);
					const examples = {
						draft_create: {},
						draft_append: {
							id,
							chunk_index: draft?.next_chunk_index ?? 0,
							content: "<resend the complete next chunk>",
						},
						draft_finalize: {
							id,
							chunk_count: draft?.next_chunk_index ?? 0,
							expected_sha256:
								draft?.sha256 ?? "<copy latest acknowledgement.sha256>",
						},
						draft_discard: { id },
						editor: {
							path: input.path ?? "<absolute path>",
							new_text:
								"<supply the intended content; empty only for deliberate deletion>",
							...selector,
						},
						apply_draft: {
							path: input.path ?? "<absolute path>",
							new_text_ref: input.new_text_ref ?? "<copy finalized draft id>",
							start_line: "<choose first line from read_file>",
							end_line: "<choose last line from read_file>",
							expected_sha256: "<copy read_file.sha256>",
							...selector,
						},
						create_from_draft: {
							path: input.path ?? "<absolute missing path>",
							new_text_ref: input.new_text_ref ?? "<copy finalized draft id>",
						},
						read_file: { path: input.path ?? "<absolute path>" },
					};
					error.recovery = {
						tool: requested,
						required_arguments: tool.inputSchema.required,
						example_arguments: examples[requested],
						...(requested === "apply_draft" || requested === "create_from_draft"
							? {
									next_step: {
										tool: "read_file",
										arguments: { path: input.path ?? "<absolute path>" },
									},
								}
							: {}),
						...(active.length ? { active_drafts: active } : {}),
						guidance:
							"Resend a corrected call with the required fields. For an existing file retain the intended edit selector and use a fresh read_file hash; do not guess missing content.",
					};
				}
				throw error;
			}
		},
		async preview(name, arguments_) {
			const tool = tools.find((tool) => tool.name === name);
			if (!["editor", "apply_draft", "create_from_draft"].includes(name))
				throw Error("Only file writes have a preview.");
			validateArguments(tool, arguments_);
			const input = { ...arguments_ };
			validate(input);
			if (input.new_text_ref !== undefined)
				input.new_text = drafts.resolve(input.new_text_ref);
			const file = await canonicalPath(input.path);
			if (roots.length && !roots.some((root) => inside(root, file)))
				throw Error("Path is outside the configured editor roots.");
			const before = await snapshot(file);
			if (name === "create_from_draft" && before)
				throw Error("Target already exists.");
			if (
				input.expected_sha256 &&
				before?.sha256 !== input.expected_sha256.toLowerCase()
			)
				throw Error(
					"File hash changed; no write performed. Read before retrying.",
				);
			const { text, operation } = updatedText(before, input);
			if (Buffer.byteLength(text) + (before?.bom ? 3 : 0) > MAX_FILE_BYTES)
				throw Error("Result exceeds the 16 MiB text-file limit.");
			const bom = before?.bom ? "\uFEFF" : "";
			return {
				path: file,
				original_text: bom + (before?.text ?? ""),
				new_text: bom + text,
				...(before ? { original_sha256: before.sha256 } : {}),
				operation,
			};
		},
		async read(arguments_, signal) {
			signal?.throwIfAborted();
			if (
				!arguments_ ||
				typeof arguments_ !== "object" ||
				Array.isArray(arguments_)
			)
				throw Error("Read arguments must be an object.");
			for (const key of Object.keys(arguments_))
				if (!Object.hasOwn(readTool().inputSchema.properties, key))
					throw Error("Unknown read argument: " + key);
			const file = await canonicalPath(arguments_.path);
			if (roots.length && !roots.some((root) => inside(root, file)))
				throw Error("Path is outside the configured editor roots.");
			const before = await snapshot(file);
			if (!before) throw Error("File does not exist.");
			if ((await canonicalPath(file)) !== file)
				throw Error("Path changed during read; inspect and retry.");
			const boundaries = lineBoundaries(before.text),
				count = boundaries.length - 1;
			const start = positiveInteger(arguments_.start_line, 1, "start_line");
			const requestedEnd = positiveInteger(
				arguments_.end_line,
				count || 1,
				"end_line",
			);
			const ceiling = positiveInteger(arguments_.max_chars, 12000, "max_chars");
			if (ceiling > 50000) throw Error("max_chars must not exceed 50000.");
			if (
				start > Math.max(count, 1) ||
				requestedEnd < start ||
				(count && requestedEnd > count) ||
				(!count && (start !== 1 || requestedEnd !== 1))
			)
				throw Error("Read range is outside the current file.");
			let end = start - 1;
			while (
				end < Math.min(requestedEnd, count) &&
				boundaries[end + 1] - boundaries[start - 1] <= ceiling
			)
				end++;
			if (count && end < start)
				throw Error(
					"The first requested line exceeds max_chars; increase it up to 50000 or inspect that long line with another reader.",
				);
			return {
				success: true,
				path: file,
				sha256: before.sha256,
				bytes: before.bytes.length,
				line_count: count,
				start_line: start,
				end_line: end,
				text: count
					? before.text.slice(boundaries[start - 1], boundaries[end])
					: "",
				truncated: end < Math.min(requestedEnd, count),
				...(end < count ? { next_start_line: end + 1 } : {}),
			};
		},
		async edit(arguments_, signal) {
			signal?.throwIfAborted();
			if (
				!arguments_ ||
				typeof arguments_ !== "object" ||
				Array.isArray(arguments_)
			)
				throw Error("Editor arguments must be an object.");
			const input = { ...arguments_ };
			validate(input);
			if (input.new_text_ref !== undefined)
				input.new_text = drafts.resolve(input.new_text_ref);
			const file = await canonicalPath(input.path);
			const key = process.platform === "win32" ? file.toLowerCase() : file;
			const previous = queues.get(key) ?? Promise.resolve();
			const job = previous
				.catch(() => {})
				.then(() => execute(file, input, signal));
			queues.set(key, job);
			try {
				return await job;
			} finally {
				if (queues.get(key) === job) queues.delete(key);
			}
		},
	};
	return api;
}
