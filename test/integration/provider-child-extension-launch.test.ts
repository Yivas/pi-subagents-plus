/**
 * The provider's extension is what serves the model, so a child that starts
 * without ambient extensions must load exactly that file. These tests drive the
 * real loader for both hosts with a marker file the extension writes when it is
 * imported: the marker is the evidence that the file ran in the child, and its
 * absence is the evidence that a launch attached nothing.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { resolveSubagentLaunchContract } from "../../src/api/preflight.ts";
import { buildAsyncRunnerSteps } from "../../src/runs/background/async-execution.ts";
import { buildRunnerChildLaunch } from "../../src/runs/background/runner-child-launch.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import { createDefaultChildSessionFactory, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { applySteeringRecoveryAgentConfig } from "../../src/runs/background/async-resume.ts";
import { registerProviderChildExtension, type ProviderChildExtensionRegistration } from "../../src/shared/provider-child-extensions.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
const assistantTurn = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: USAGE };

let tempDir = "";
let providerCounter = 0;
let provider = "";
let agentDirectory = "";
let markerPath = "";
let sentinelPath = "";
let providerPath = "";
let registration: ProviderChildExtensionRegistration | undefined;

/** A pi module stub that resolves the model only when the provider's extension was imported by this child. */
function markerPi(requireMarker = true): PiCodingAgentModule {
	return {
		ModelRuntime: { create: async () => ({ registerProvider() {}, registerNativeProvider() {}, getRegisteredProviderIds: () => [], refresh: async () => {} }) },
		SettingsManager,
		DefaultResourceLoader,
		SessionManager: { inMemory: () => ({}), create: () => ({}) },
		resolveCliModel: (({ cliModel }: { cliModel: string }) => !requireMarker || fs.existsSync(markerPath)
			? { model: { provider, id: "echo" } }
			: { error: `Model "${cliModel}" not found. Use --list-models to see available models.` }) as unknown as PiCodingAgentModule["resolveCliModel"],
		createAgentSession: (async () => {
			const listeners: Array<(event: unknown) => void> = [];
			const messages: unknown[] = [];
			return {
				session: {
					model: { provider, id: "echo" }, messages, sessionId: "provider-child", extensionRunner: { hasHandlers: () => false },
					bindExtensions: async () => {},
					dispose() {}, abort: async () => {}, steer: async () => {}, followUp: async () => {},
					subscribe: (listener: (event: unknown) => void) => { listeners.push(listener); return () => {}; },
					prompt: async (text: string) => {
						for (const message of [{ role: "user", content: [{ type: "text", text }] }, assistantTurn]) {
							messages.push(message);
							for (const listener of listeners) listener({ type: "message_end", message });
						}
					},
				},
			};
		}) as unknown as PiCodingAgentModule["createAgentSession"],
	} as unknown as PiCodingAgentModule;
}

function modelId(): string {
	return `${provider}/echo`;
}

beforeEach(() => {
	tempDir = createTempDir();
	providerCounter += 1;
	provider = `bridgechild-${process.pid}-${providerCounter}`;
	const cwd = path.join(tempDir, "repo");
	agentDirectory = path.join(tempDir, "provider");
	fs.mkdirSync(agentDirectory, { recursive: true });
	fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
	markerPath = path.join(tempDir, "provider-child-extension.marker");
	sentinelPath = path.join(tempDir, "ambient-sentinel.marker");
	providerPath = path.join(agentDirectory, "provider-extension.mjs");
	fs.writeFileSync(
		providerPath,
		`import * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(markerPath)}, "loaded");\nexport default () => {};\n`,
		"utf-8",
	);
	fs.writeFileSync(
		path.join(cwd, ".pi", "extensions", "ambient-sentinel.mjs"),
		`import * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(sentinelPath)}, "loaded");\nexport default () => {};\n`,
		"utf-8",
	);
	registration = registerProviderChildExtension({ provider, path: providerPath, owner: "provider-child-extension-launch" });
});

afterEach(() => {
	registration?.dispose();
	registration = undefined;
	removeTempDir(tempDir);
});

describe("provider child extension launches", () => {
	it("loads the provider's file in a foreground child and keeps the ambient sentinel out", async () => {
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => markerPi(false) });
		const result = await runSync(
			path.join(tempDir, "repo"),
			[makeAgent("provider-child", { model: modelId(), extensions: [], providerChildExtensions: true })],
			"provider-child",
			"Task",
			{
				runId: "provider-child-foreground",
				waitToolEnabled: false,
				childSessionFactory: factory,
				projectTrusted: true,
				availableModels: [{ provider, id: "echo", fullId: modelId() }] as never,
			},
		);

		assert.equal(result.exitCode, 0, result.error);
		assert.equal(fs.existsSync(markerPath), true, "the provider's extension must be imported by the child");
		assert.equal(fs.existsSync(sentinelPath), false, "an empty extensions list must keep the ambient sentinel out");
	});

	it("keeps the file out when the switch is off, so the model does not resolve", async () => {
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => markerPi() });
		const result = await runSync(
			path.join(tempDir, "repo"),
			[makeAgent("provider-child-off", { model: modelId(), extensions: [] })],
			"provider-child-off",
			"Task",
			{ runId: "provider-child-foreground-off", waitToolEnabled: false, childSessionFactory: factory, projectTrusted: true },
		);

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /not found/);
		assert.equal(fs.existsSync(markerPath), false, "a launch with the switch off must attach nothing");
	});

	it("loads the provider's file in a background child the runner builds from a step", async () => {
		const built = buildAsyncRunnerSteps(uniqueSessionId("async"), {
			chain: [{ agent: "provider-child-async", task: "Task" }],
			agents: [makeAgent("provider-child-async", { model: modelId(), extensions: [], providerChildExtensions: true })],
			ctx: { pi: {} as never, cwd: path.join(tempDir, "repo"), currentSessionId: "parent" },
			availableModels: [{ provider, id: "echo", fullId: modelId() } as never],
			asyncDir: path.join(tempDir, "async"),
			maxSubagentDepth: 1,
		});
		if (!("steps" in built)) throw new Error(`the step must build: ${built.error}`);
		const [step] = built.steps as Array<Parameters<typeof buildRunnerChildLaunch>[0]>;
		assert.deepEqual(step?.providerChildExtension, { provider, path: fs.realpathSync(providerPath) });

		const launch = buildRunnerChildLaunch(step!, { cwd: path.join(tempDir, "repo"), id: uniqueSessionId("runner"), flatIndex: 0, projectTrusted: true }, { model: modelId(), sessionEnabled: false, watchdogStatus: () => {} });
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => markerPi() });
		const run = await runChildSession({ factory, launch, prompt: "Task: Task", appendChildEvent: () => {}, writeOutputLine: () => {} });

		assert.equal(run.exitCode, 0, run.error);
		assert.equal(fs.existsSync(markerPath), true, "the runner child must import the recorded provider file");
		assert.equal(fs.existsSync(sentinelPath), false);
	});
});

describe("provider child extension in the published launch contract", () => {
	function writeAgent(relativeName: string, body: string): string {
		const agentsDir = path.join(tempDir, "repo", ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		const filePath = path.join(agentsDir, `${relativeName}.md`);
		fs.writeFileSync(filePath, body, "utf-8");
		return filePath;
	}

	it("reports the derived file it publishes, and nothing when the switch is off", async () => {
		const cwd = path.join(tempDir, "repo");
		writeAgent(
			"provider-child-on",
			`---\nname: provider-child-on\ndescription: Provider child extension\nmodel: ${modelId()}\nproviderChildExtensions: true\nextensions:\n  - ./unused.mjs\n---\nFixture.\n`,
		);
		writeAgent(
			"provider-child-upstream",
			`---\nname: provider-child-upstream\ndescription: Control without the switch\nmodel: ${modelId()}\nextensions:\n  - ./unused.mjs\n---\nFixture.\n`,
		);
		const availableModels = [{ provider, id: "echo", fullId: modelId() }] as never;
		const on = await resolveSubagentLaunchContract({ agent: "provider-child-on", cwd, task: "Task", runId: uniqueSessionId("preflight-on"), availableModels, intercomBridge: { mode: "off" } });
		const off = await resolveSubagentLaunchContract({ agent: "provider-child-upstream", cwd, task: "Task", runId: uniqueSessionId("preflight-off"), availableModels, intercomBridge: { mode: "off" } });
		if (!on.ok) throw new Error(`preflight must resolve: ${on.message}`);
		if (!off.ok) throw new Error(`preflight must resolve: ${off.message}`);
		const canonical = fs.realpathSync(providerPath);

		assert.deepEqual(on.contract.tools.providerDerivedExtensions, [{ path: canonical, provider, model: modelId() }]);
		assert.equal(on.contract.tools.configuredExtensions.includes(canonical), true);
		assert.equal(on.contract.tools.extensionArgs.includes(canonical), true);
		assert.notEqual(on.contract.launchContractDigest, off.contract.launchContractDigest);

		assert.equal("providerDerivedExtensions" in off.contract.tools, false, "the field is absent, not empty, when nothing applies");
		assert.equal(off.contract.tools.configuredExtensions.includes(canonical), false);
		assert.equal(off.contract.tools.extensionArgs.includes(canonical), false);
	});
});

describe("provider child extension resume contract", () => {
	it("replays the recorded switch through the agent config a resume sees", () => {
		const recorded = { enabled: true, provider, path: fs.realpathSync(providerPath), model: modelId() };
		const resumed = applySteeringRecoveryAgentConfig(
			makeAgent("provider-child"),
			{ providerChildExtension: recorded } as unknown as Parameters<typeof applySteeringRecoveryAgentConfig>[1],
		);
		assert.equal(resumed.providerChildExtensions, true, "the recorded switch wins over current settings");

		const withoutRecord = applySteeringRecoveryAgentConfig(
			makeAgent("provider-child", { providerChildExtensions: true }),
			{} as unknown as Parameters<typeof applySteeringRecoveryAgentConfig>[1],
		);
		assert.equal(withoutRecord.providerChildExtensions, undefined, "a run that recorded nothing resumes as upstream");
	});
});

function uniqueSessionId(label: string): string {
	return `${label}-${process.pid}-${providerCounter}-${tempDir.length}`;
}
