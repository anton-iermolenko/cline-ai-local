# What AI Local changes from upstream Cline

This inventory describes the fork's current additions and behavior changes on top of Cline's coding-agent foundation. It is organized by user value, with source links and representative local commits. It is not a count of features unique to Cline or a claim that each intermediate experiment remains active.

The initial audit reviewed all 61 non-merge commits in the local `origin/main..local-main` range through `3f94d5c20`, including its integration merges. The common upstream ancestor at that audit was `f817e59f6`. Commit references below identify the local integration history; current source is authoritative.

## Model configuration and context visibility

| Change | Current implementation | Representative commits |
| --- | --- | --- |
| Native vLLM/HyperQwen and llama.cpp providers, discovery, native request counting, image-token accounting and serialized inference controls | [Provider guide](provider-config/local-inference.mdx), [local inference transport](../sdk/packages/llms/src/providers/local-inference.ts), [provider discovery](../sdk/packages/core/src/services/providers/local-inference-discovery.ts), [image accounting](../sdk/packages/core/src/extensions/context/image-token-accounting.ts) | `3ce9ac935`, `1620052d8`, `5cfe90701`, `430125d5a` |
| A dedicated settings screen with context/output/compaction fields, inherited versus overridden values, reasoning and sampling controls, and a full allocation breakdown | [Settings form](../apps/vscode/webview-ui/src/components/settings/providers/LocalInferenceSettingsForm.tsx), [budget calculation](../sdk/packages/shared/src/llms/local-model-budget.ts) | `e21a4880b`, `14a1db406`, `034318bd1`, `9d367c08a` |
| Default/P1/P2 slots per provider/server/model; shared editor/CLI selection; model IDs and active-slot footer labels; editable token-cost estimates per model | [Profile storage](../sdk/packages/core/src/services/storage/provider-settings-manager.ts), [CLI profile selection](../apps/cli/src/utils/local-model-profiles.ts), [cost controls](../apps/vscode/webview-ui/src/components/settings/providers/LocalModelCostSettings.tsx) | `c845dc3cd`, `d223c5b72`, `daaca2d6e` |

The budget separates tools/instructions, summary allowance, raw recent history, normal output including thinking, counting margin/boundary and iteration space. It includes the preferred compaction target, minimum iteration reserve, hard compaction cap and maximum context. The allocation display contains planning estimates; supported native counters measure the actual prepared request. Context and output limits are restored into the running session, not just displayed in settings.

## Memory, evidence and execution

| Change | Current implementation | Representative commits |
| --- | --- | --- |
| Measured compaction admission and overflow recovery, chronological window markers and transition into recent messages, capped notes accepted without smaller retries, and balanced adjacent reductions across compactions | [Compaction policy](../sdk/packages/core/src/extensions/context/compaction.ts), [window summaries](../sdk/packages/core/src/extensions/context/measured-summary.ts) | `1620052d8`, `09ee22f84`, `daaca2d6e`, `7f0d1b3b8`, `495627658`, `d84b93bb2` |
| Preserve usable context across resume, missing-state recovery, checkpoint restore, repeated Undo and edited-message regeneration; stabilize prepared summarized prefixes | [Recovery](../sdk/packages/core/src/session/services/context-recovery.ts), [saved compaction](../sdk/packages/core/src/session/models/session-compaction.ts), [extension coordinator](../apps/vscode/src/sdk/sdk-compaction-coordinator.ts) | `5882da1a4`, `03eccc6d4`, `ef99d5d20`, `2eeba8380`, `71a851478` |
| Search/page acquisition provider separation; file-backed page loading, search and bounded reads; packaged page worker rather than injecting complete pages into the conversation | [Research guide](sdk/web-research.mdx), [tool implementation](../sdk/packages/core/src/extensions/tools/web-pages.ts) | `a3a58caca` |
| Native file-editor family with bounded/hash reads, exact-range edits, staged drafts with configurable 8,000-character chunks and explicit limit/retry feedback, guarded apply/create (including empty `old_text` for missing files), and matching previews/commits | [Editor guide](sdk/native-file-editor.mdx), [engine](../sdk/packages/core/src/extensions/tools/file-editor/engine/editor.mjs), [draft protocol](../sdk/packages/core/src/extensions/tools/file-editor/engine/drafts.mjs) | `da36584de` |
| Native/headless foreground wait expiry -> same-PID background handoff with an open log; explicit foreground cancellation; continued output and exit records | [Native executor](../sdk/packages/core/src/extensions/tools/executors/bash.ts), [tool wrapper](../sdk/packages/core/src/extensions/tools/definitions.ts), [VS Code headless forwarding](../apps/vscode/src/sdk/vscode-run-commands-tool.ts) | `7f0d1b3b8`, `2763cf8ee` |
| PID identity checks, bounded log-tail process waits and validated expert-status waits; wait deadlines do not kill jobs; batched progress avoids shell polling and false loop failures | [Process wait](../sdk/packages/core/src/extensions/tools/process-wait.ts), [wait contract](../sdk/packages/core/src/runtime/safety/job-wait.ts), [runtime tracker](../sdk/packages/core/src/runtime/safety/job-wait-tracker.ts) | `ca11224d1`, `6d617933a`, `e5a866bf4`, `4d17e22d6` |
| Bounded/batched terminal reasoning previews and a proportional context meter | [Reasoning preview](../apps/cli/src/tui/utils/reasoning-preview.ts), [status bar](../apps/cli/src/tui/components/status-bar.tsx) | `c91a7a867`, `4f087acea` |

Current compaction protects the latest human instruction verbatim and summarizes older user messages normally. Map passes receive only their own window; previous notes are retained locally. Summaries are model-generated and may contain errors or conflicting historical hypotheses. Canonical history is retained for verification. Early assistant-prefill experiments, retention of every original user input, and frozen-prefix summary-reduction experiments were superseded and are not current features.

VS Code [resume pairing cleanup](../apps/vscode/src/sdk/initial-message-sanitizer.ts) preserves separate hook/system and human follow-up envelopes, including their metadata. Saved compaction fingerprints continue to validate after cleanup and the agent codec round trip, so resuming with an image does not replay the archive because system metadata was discarded.

Command handoff applies to the native CLI/headless path. Visible VS Code terminal execution has its existing terminal-specific handoff. Remote PIDs require remote observation. A process wait reports liveness; disappearing from the process table does not by itself establish a successful exit.

## Optional workflow support and operational integration

| Change | Current implementation | Representative commits |
| --- | --- | --- |
| Portable global rule supplements, aligned with the shared non-YOLO Act prompt; proportionate planning, evidence, recovery and delivery guidance without duplicating default instructions | [Bootstrap kit](../bootstrap/README.md), [default coverage map](../bootstrap/rules/README.md), [Act prompt](../sdk/packages/shared/src/prompt/system/act.ts) | `5ade2b862`, `0d3bc31d8`, `a8d9e8209` |
| Opt-in Linux/WSL `consult-expert` stdio MCP with durable job supervision, explicit-request/permission boundaries and setup templates | [Expert setup and contracts](../bootstrap/consult-expert/README.md) | `5ade2b862` |
| Opt-in CLI completion/error and waiting-for-answer notifications, with Home Assistant webhook examples | [Notification setup](../bootstrap/notifications/README.md) | `5ade2b862`, `3ae4c2928` |
| Code-server closed-output logging guards; shared-runtime compaction transport, edited-message and Request/stream handling repairs | [Logger guard](../apps/vscode/src/shared/services/Logger.ts), [extension transport](../apps/vscode/src/sdk/cline-session-factory.ts), [compaction bridge](../apps/vscode/src/sdk/sdk-compaction.ts) | `29fe258f4`, `430125d5a` |
| One committed SDK source for the CLI/extension, calendar fork versioning, provenance/fingerprint/hash verification, stale-Hub diagnostics, development artifacts without moving release tags | [Build/deployment guide](../local/README.md), [build verification](../local/release.py), [integration workflow](../LOCAL_DEVELOPMENT.md) | `8e692db79`, `25657dd51`, `83e0f5b71`, `feb9884b9` |
| Fork CI coverage on `local-main`, quiet-period gating and upstream-only coverage-service uploads | [Fork CI policy](../LOCAL_DEVELOPMENT.md#fork-github-actions) | `2fb15d1f9`, `4de4c3d2c`, `e1620a8b5` |

Bootstrap rules, expert tools and notification hooks are opt-in setup material. Building the clients does not activate them, configure provider accounts, or install a user's credentials. Application/package identifiers and upstream authorship/license remain intact.

## Release validation

The 2026.10.3 release also stamps source-bundled desktop backends with the same SDK fingerprint as the CLI ([build definitions](../apps/examples/desktop-app/scripts/runtime-define-args.ts)). The compiled startup suite checks starting and reusing a Hub, proxy handling, and discovery recovery. Hub server fixtures isolate their real session/SQLite stores as well as discovery; cold CLI module-import checks have explicit startup budgets. CI provisions Python explicitly for real hook execution; native input allowances preserve their configured total context, while general-provider context overrides still reach Ollama num_ctx. Corrupt-history assertions follow the sanitized rejection contract.

## Keep this inventory current

For a user-facing fork change, review the merged commits and final source, then update the relevant entry here. Update the root README when the public feature set or positioning changes; keep implementation details and supporting commit references here. Replace obsolete descriptions when an approach is superseded. A bug-fix commit does not automatically warrant another headline feature.
