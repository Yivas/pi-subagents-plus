import assert from "node:assert/strict";
import childProcess from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { readAsyncRecoveryDescriptor } from "../../src/runs/background/async-resume.ts";
import { createRunFanoutBudget } from "../../src/runs/shared/run-fanout-budget.ts";
import { registerProviderChildExtension } from "../../src/shared/provider-child-extensions.ts";
import { DIRS, type SubagentState } from "../../src/shared/types.ts";
import { createEventBus, makeAgent } from "../support/helpers.ts";

describe("subagent executor provider resume", () => {
	for (const change of ["removed registration", "changed registration", "missing file"] as const) {
		it(`replays the recorded provider extension through action=resume with ${change}`, async (t) => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-resume-"));
			const sourceId = `provider-resume-${process.pid}-${change.replaceAll(" ", "-")}`;
			const provider = `resume-${process.pid}`;
			const sourceDir = path.join(DIRS.async, sourceId);
			const budget = createRunFanoutBudget(sourceId, 10);
			const before = new Set(fs.existsSync(DIRS.async) ? fs.readdirSync(DIRS.async) : []);
			const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("captured detached spawn"); });
			syncBuiltinESMExports();
			let replacement: ReturnType<typeof registerProviderChildExtension> | undefined;
			try {
				fs.mkdirSync(path.join(root, ".pi"));
				const sessionFile = path.join(root, "child.jsonl");
				fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 1, id: sourceId, cwd: root })}\n`);
				const providerPath = path.join(root, "provider.mjs");
				fs.writeFileSync(providerPath, "export default () => {};\n");
				const registration = registerProviderChildExtension({ provider, path: providerPath, owner: "resume-fixture" });
				const recorded = { enabled: true, provider, path: fs.realpathSync(providerPath), model: `${provider}/echo` };
				registration.dispose();
				if (change === "changed registration") {
					const otherPath = path.join(root, "replacement.mjs");
					fs.writeFileSync(otherPath, "export default () => {};\n");
					replacement = registerProviderChildExtension({ provider, path: otherPath, owner: "replacement-fixture" });
				}
				if (change === "missing file") fs.rmSync(providerPath);
				fs.mkdirSync(sourceDir, { recursive: true });
				fs.writeFileSync(path.join(sourceDir, "status.json"), JSON.stringify({
					runId: sourceId, mode: "single", state: "complete", startedAt: 100, endedAt: 200, lastUpdate: 200, cwd: root,
					sessionId: "provider-resume-parent", sessionFile, steps: [{ agent: "worker", status: "complete", sessionFile }],
				}));
				fs.writeFileSync(path.join(sourceDir, "recovery-descriptor.json"), JSON.stringify({
					version: 1, runFanoutBudget: budget, sourceRunId: sourceId, agent: "worker", cwd: root, sessionFile,
					systemPromptMode: "replace", inheritGlobalContext: false, inheritProjectContext: false, inheritSkills: false,
					outputMode: "inline", maxSubagentDepth: 2, share: false, model: recorded.model, extensions: [], providerChildExtension: recorded,
				}));
				const state = {
					baseCwd: root, currentSessionId: null, asyncJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(),
					lastForegroundControlId: null, pendingForegroundControlNotices: new Map(), cleanupTimers: new Map(), lastUiContext: null,
					poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear() {} },
				} as SubagentState;
				const executor = createSubagentExecutor({
					pi: { events: createEventBus(), getSessionName: () => "parent" } as never, state,
					config: { maxSubagentDepth: 2, intercomBridge: { mode: "off" } } as never,
					asyncByDefault: false, tempArtifactsDir: root, getSubagentSessionRoot: () => path.join(root, "sessions"), expandTilde: (value) => value,
					discoverAgents: () => ({ agents: [makeAgent("worker", { extensions: [], providerChildExtensions: false })] }),
				});
				const ctx = {
					cwd: root, hasUI: false,
					sessionManager: { getSessionId: () => "provider-resume-parent", getSessionFile: () => null },
					modelRegistry: { getAvailable: () => [{ provider, id: "echo" }], getRegisteredProviderIds: () => [] },
				} as never;

				const result = await executor.executePublic("resume-provider", { action: "resume", id: sourceId, message: "Continue", acceptance: false }, new AbortController().signal, undefined, ctx);

				assert.equal(result.isError, true, "the test intercepts detached process creation, not the resume implementation");
				const message = result.content[0]?.type === "text" ? result.content[0].text : "";
				if (change === "missing file") {
					assert.match(message, /Cannot resume with provider child extension/);
					assert.ok(message.includes(recorded.path));
					assert.match(message, /no longer exists/);
					assert.equal(spawn.mock.callCount(), 0);
				} else {
					assert.match(message, /captured detached spawn/);
					assert.equal(spawn.mock.callCount(), 1);
					const resumedDirs = fs.readdirSync(DIRS.async).filter((entry) => entry !== sourceId && !before.has(entry));
					assert.equal(resumedDirs.length, 1);
					assert.deepEqual(readAsyncRecoveryDescriptor(path.join(DIRS.async, resumedDirs[0]!))?.providerChildExtension, recorded);
				}
			} finally {
				replacement?.dispose();
				t.mock.restoreAll();
				syncBuiltinESMExports();
				for (const entry of fs.existsSync(DIRS.async) ? fs.readdirSync(DIRS.async) : []) {
					if (!before.has(entry)) fs.rmSync(path.join(DIRS.async, entry), { recursive: true, force: true });
				}
				fs.rmSync(budget.directory, { recursive: true, force: true });
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	}
});
