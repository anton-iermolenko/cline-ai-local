import { createHash, randomUUID } from "node:crypto";

const MAX_BYTES = 16 * 1024 * 1024;
const TTL_MS = 30 * 60 * 1000;
const DEFAULT_DRAFT_CHUNK_CHARS = 8000;
const digest = (text) => createHash("sha256").update(text).digest("hex");

export function draftTools(chunkChars) {
	const id = {
		type: "string",
		minLength: 1,
		description:
			"Copy the EXACT id from draft_create or a draft acknowledgement. Required on EVERY call.",
	};
	const tool = (name, description, properties, idempotentHint = true) => ({
		name,
		description,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: Object.keys(properties),
			properties,
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint,
			openWorldHint: false,
		},
	});
	return [
		tool(
			"draft_create",
			"Start a temporary in-memory draft; returns id, empty sha256 and next_chunk_index=0. Next call draft_append with that id. Drafts expire after 30 idle minutes and disappear on session reset/restart. This does not edit a file.",
			{},
			false,
		),
		tool(
			"draft_append",
			"Maximum content length: " +
				chunkChars +
				" characters. Append ONE ordered content chunk. REQUIRED: id, chunk_index, content. Copy id from draft_create and chunk_index from next_chunk_index. Wait for the acknowledgement before the next chunk. Identical retries at the same index are safe. Include needed newlines; no separator is added. Keep each complete JSON call within the output budget. This does not edit a file. Finalize-only fields are not accepted here.",
			{
				id,
				chunk_index: {
					type: "integer",
					minimum: 0,
					description:
						"Copy next_chunk_index from the latest accepted acknowledgement.",
				},
				content: {
					type: "string",
					description:
						"Maximum content length: " +
						chunkChars +
						" characters. One complete chunk. Quotes still need JSON escaping.",
				},
			},
		),
		tool(
			"draft_finalize",
			"Seal a draft after all chunks are acknowledged. REQUIRED: id, chunk_count, expected_sha256. Copy chunk_count from the latest next_chunk_index and expected_sha256 from that same acknowledgement. Then use apply_draft with new_text_ref=id. This does not edit a file.",
			{
				id,
				chunk_count: {
					type: "integer",
					minimum: 0,
					description:
						"The latest acknowledged next_chunk_index, not the last chunk_index.",
				},
				expected_sha256: {
					type: "string",
					description:
						"Cumulative sha256 from the latest acknowledgement (or draft_create for empty content).",
				},
			},
		),
		tool(
			"draft_discard",
			"Free a draft by id when finished. Repeating discard is harmless. This does not edit a file.",
			{ id },
		),
	];
}

export function createDraftStore({
	draftChunkChars = DEFAULT_DRAFT_CHUNK_CHARS,
	ttlMs = TTL_MS,
	now = Date.now,
} = {}) {
	if (
		!Number.isSafeInteger(draftChunkChars) ||
		draftChunkChars < 1 ||
		draftChunkChars > MAX_BYTES
	)
		throw Error("draftChunkChars must be an integer between 1 and 16777216.");
	const chunkChars = draftChunkChars;
	const drafts = new Map();
	let storedBytes = 0;
	function remove(id) {
		const draft = drafts.get(id);
		if (draft) storedBytes -= draft.bytes;
		drafts.delete(id);
	}
	function sweep() {
		for (const [id, draft] of drafts) if (draft.expires <= now()) remove(id);
	}
	function get(id) {
		sweep();
		const draft = drafts.get(id);
		if (!draft)
			throw Error(
				"Draft not found or expired. Drafts are local to this editor session; recreate it after a restart.",
			);
		return draft;
	}
	function summary(id, draft) {
		return {
			success: true,
			id,
			sha256: draft.hasher.copy().digest("hex"),
			chars: draft.chars,
			bytes: draft.bytes,
			next_chunk_index: draft.chunks.length,
			max_chunk_chars: chunkChars,
			finalized: draft.finalized,
			expires_at: new Date(draft.expires).toISOString(),
		};
	}
	return {
		tools: draftTools(chunkChars),
		describe() {
			sweep();
			return [...drafts].map(([id, draft]) => summary(id, draft));
		},
		resolve(id) {
			const draft = get(id);
			if (!draft.finalized)
				throw Error(
					"Draft is not finalized. Finalize using chunk_count and the last acknowledged sha256 before applying it.",
				);
			draft.expires = now() + ttlMs;
			return draft.chunks.map((chunk) => chunk.content).join("");
		},
		handle(input) {
			if (!input || typeof input !== "object" || Array.isArray(input))
				throw Error("Draft arguments must be an object.");
			const allowed = {
				create: ["action"],
				append: ["action", "id", "chunk_index", "content"],
				finalize: ["action", "id", "chunk_count", "expected_sha256"],
				discard: ["action", "id"],
			}[input.action];
			if (!allowed)
				throw Error(
					"Choose draft action create, append, finalize, or discard.",
				);
			for (const key of Object.keys(input))
				if (!allowed.includes(key))
					throw Error(
						"Unexpected argument for draft " + input.action + ": " + key,
					);
			sweep();
			if (input.action === "create") {
				if (drafts.size >= 8)
					throw Error(
						"At most 8 drafts may exist. Discard an unused draft first.",
					);
				const id = randomUUID();
				const draft = {
					chunks: [],
					hasher: createHash("sha256"),
					chars: 0,
					bytes: 0,
					finalized: false,
					expires: now() + ttlMs,
				};
				drafts.set(id, draft);
				return summary(id, draft);
			}
			if (typeof input.id !== "string" || !input.id)
				throw Error("id must be a draft id returned by create.");
			// Discard is idempotent, including after expiry.
			if (input.action === "discard") {
				remove(input.id);
				return { success: true, id: input.id, discarded: true };
			}
			const draft = get(input.id);
			if (input.action === "append") {
				if (!Number.isSafeInteger(input.chunk_index) || input.chunk_index < 0)
					throw Error("chunk_index must be a nonnegative integer.");
				if (
					typeof input.content !== "string" ||
					input.content.includes("\0") ||
					!input.content.isWellFormed()
				)
					throw Error(
						"content must be a NUL-free, well-formed Unicode string. Do not split surrogate pairs between chunks.",
					);
				if (input.content.length > chunkChars) {
					const error = Error(
						"Received " +
							input.content.length +
							" characters; maximum " +
							chunkChars +
							". Nothing was appended. Resend smaller chunks starting at index " +
							draft.chunks.length +
							".",
					);
					error.code = "draft_chunk_too_large";
					error.diagnostics = {
						actual_chars: input.content.length,
						max_chunk_chars: chunkChars,
						next_chunk_index: draft.chunks.length,
					};
					throw error;
				}
				const existing = draft.chunks[input.chunk_index];
				if (existing) {
					if (existing.content !== input.content)
						throw Error(
							"Chunk index already contains different content; no draft changes made.",
						);
					draft.expires = now() + ttlMs;
					return { ...existing.ack, replayed: true };
				}
				if (draft.finalized)
					throw Error("A finalized draft is immutable. Create another draft.");
				if (input.chunk_index !== draft.chunks.length)
					throw Error(
						"Out-of-order chunk. Expected chunk_index " +
							draft.chunks.length +
							"; no draft changes made.",
					);
				const bytes = Buffer.byteLength(input.content);
				if (storedBytes + bytes > MAX_BYTES || draft.chunks.length >= 8192)
					throw Error(
						"Draft storage limit reached (16 MiB total, 8192 chunks per draft). Discard unused drafts.",
					);
				draft.hasher.update(input.content);
				draft.chars += input.content.length;
				draft.bytes += bytes;
				storedBytes += bytes;
				draft.expires = now() + ttlMs;
				draft.chunks.push({ content: input.content });
				const ack = {
					...summary(input.id, draft),
					chunk_index: input.chunk_index,
					chunk_sha256: digest(input.content),
				};
				draft.chunks.at(-1).ack = ack;
				return ack;
			}
			if (
				!Number.isSafeInteger(input.chunk_count) ||
				input.chunk_count !== draft.chunks.length
			)
				throw Error(
					"chunk_count must equal the acknowledged chunk count: " +
						draft.chunks.length,
				);
			if (
				typeof input.expected_sha256 !== "string" ||
				!/^[a-fA-F0-9]{64}$/.test(input.expected_sha256) ||
				input.expected_sha256.toLowerCase() !==
					draft.hasher.copy().digest("hex")
			)
				throw Error(
					"Draft hash does not match the acknowledged content; no draft changes made.",
				);
			draft.finalized = true;
			draft.expires = now() + ttlMs;
			return summary(input.id, draft);
		},
	};
}
