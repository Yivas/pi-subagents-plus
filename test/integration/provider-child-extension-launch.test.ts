import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSubagentLaunchContract } from "../../src/api/preflight.ts";
import { buildAsyncRunnerSteps } from "../../src/runs/background/async-execution.ts";
import { buildRunnerChildLaunch } from "../../src/runs/background/runner-child-launch.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { createDefaultChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { applySteeringRecoveryAgentConfig } from "../../src/runs/background/async-resume.ts";
import { registerProviderChildExtension, resolveProviderChildExtensionLaunch, type ProviderChildExtensionRegistration } from "../../src/shared/provider-child-extensions.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";

const RESPONSE = "PROVIDER-HANDLED";
const PARENT_HISTORY = "PERSISTED-PARENT-HISTORY";
let tempDir = "";
let providerCounter = 0;
let provider = "";
let markerPath = "";
let requestPath = "";
let sentinelPath = "";
let providerPath = "";
let registration: ProviderChildExtensionRegistration | undefined;
let previousEnv: Record<string, string | undefined>;

function modelId(): string { return `${provider}/echo`; }
const realFactory = () => createDefaultChildSessionFactory({ loadPiCodingAgent: () => import("@earendil-works/pi-coding-agent") });

beforeEach(() => {
	tempDir = createTempDir();
	previousEnv = Object.fromEntries(["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]));
	process.env.HOME = path.join(tempDir, "home");
	process.env.USERPROFILE = process.env.HOME;
	process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "home", ".pi", "agent");
	providerCounter += 1;
	provider = `bridgechild-${process.pid}-${providerCounter}`;
	const cwd = path.join(tempDir, "repo");
	fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
	markerPath = path.join(tempDir, "provider-response.marker");
	requestPath = path.join(tempDir, "provider-request.json");
	sentinelPath = path.join(tempDir, "ambient-sentinel.marker");
	providerPath = path.join(tempDir, "provider-extension.mjs");
	// The marker is written by the response handler, never by importing the extension.
	fs.writeFileSync(providerPath, `
import * as fs from "node:fs";
import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default (pi) => {
  const local = fauxProvider({ provider: ${JSON.stringify(provider)}, models: [{ id: "echo" }], tokensPerSecond: 100000 });
  local.setResponses([(context) => {
    fs.writeFileSync(${JSON.stringify(requestPath)}, JSON.stringify(context.messages));
    fs.writeFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(RESPONSE)});
    return fauxAssistantMessage(${JSON.stringify(RESPONSE)});
  }]);
  pi.registerProvider(local.provider);
};
`, "utf-8");
	fs.writeFileSync(path.join(cwd, ".pi", "extensions", "ambient-sentinel.mjs"), `import * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(sentinelPath)}, "loaded");\nexport default () => {};\n`);
	registration = registerProviderChildExtension({ provider, path: providerPath, owner: "provider-child-extension-launch" });
});

afterEach(() => {
	registration?.dispose();
	registration = undefined;
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	removeTempDir(tempDir);
});

describe("provider child extension launches", () => {
	for (const context of ["fresh", "fork"] as const) {
		for (const enabled of [true, false]) {
			it(`${context} with switch ${enabled} ${enabled ? "sends the request through the registered provider" : "does not use that provider"}`, async () => {
				const cwd = path.join(tempDir, "repo");
				let sessionFile: string | undefined;
				if (context === "fork") {
					const parent = SessionManager.create(cwd, path.join(tempDir, "parent-sessions"));
					parent.appendMessage({ role: "user", content: PARENT_HISTORY, timestamp: Date.now() });
					parent.appendMessage(fauxAssistantMessage("Persisted parent response."));
					const parentFile = parent.getSessionFile();
					assert.ok(parentFile && fs.existsSync(parentFile), "the fork must inherit a persisted session, not an in-memory substitute");
					const leaf = parent.getLeafId();
					assert.ok(leaf);
					sessionFile = parent.createBranchedSession(leaf) ?? undefined;
					assert.ok(sessionFile && fs.readFileSync(sessionFile, "utf-8").includes(PARENT_HISTORY));
				}
				const agent = makeAgent("provider-child", { model: modelId(), extensions: [], providerChildExtensions: enabled });
				const resolved = resolveProviderChildExtensionLaunch({ agent, model: modelId(), availableModels: [{ provider, id: "echo", fullId: modelId() }] as never, externalRunner: false, remoteMachine: false });
				const { session } = buildInProcessChildLaunch({
					host: "parent", cwd, childAgentName: agent.name, childIndex: 0, model: modelId(), tools: ["read"], extensions: [],
					providerChildExtension: resolved?.reference, sessionEnabled: true, sessionFile,
					...(context === "fork" ? { forkCacheKey: "pi-fork:provider-test" } : {}), waitToolEnabled: false,
				});
				const factory = realFactory();
				try {
					if (enabled) {
						const child = await factory.create(session);
						try {
							await child.prompt("Task: respond locally.");
							assert.match(JSON.stringify(child.messages.at(-1)), /PROVIDER-HANDLED/);
							assert.equal(fs.readFileSync(markerPath, "utf-8"), RESPONSE);
							const request = fs.readFileSync(requestPath, "utf-8");
							assert.match(request, /respond locally/);
							assert.equal(request.includes(PARENT_HISTORY), context === "fork");
						} finally { await child.dispose(); }
					} else {
						await assert.rejects(factory.create(session), /not found|Unknown model/i);
						assert.equal(fs.existsSync(markerPath), false);
						assert.equal(fs.existsSync(requestPath), false);
					}
					assert.equal(fs.existsSync(sentinelPath), false, "extensions: [] must exclude ambient extensions");
				} finally { await factory.dispose(); }
			});
		}
	}

	it("serves a real background child request through the provider extension recorded in its step", async () => {
		const built = buildAsyncRunnerSteps(uniqueSessionId("async"), {
			chain: [{ agent: "provider-child-async", task: "Task" }],
			agents: [makeAgent("provider-child-async", { model: modelId(), extensions: [], providerChildExtensions: true })],
			ctx: { pi: {} as never, cwd: path.join(tempDir, "repo"), currentSessionId: "parent" },
			availableModels: [{ provider, id: "echo", fullId: modelId() } as never], asyncDir: path.join(tempDir, "async"), maxSubagentDepth: 1,
		});
		if (!("steps" in built)) throw new Error(`the step must build: ${built.error}`);
		const [step] = built.steps as Array<Parameters<typeof buildRunnerChildLaunch>[0]>;
		assert.deepEqual(step?.providerChildExtension, { provider, path: fs.realpathSync(providerPath) });
		const launch = buildRunnerChildLaunch(step!, { cwd: path.join(tempDir, "repo"), id: uniqueSessionId("runner"), flatIndex: 0, projectTrusted: true }, { model: modelId(), sessionEnabled: false, watchdogStatus: () => {} });
		const factory = realFactory();
		try {
			const run = await runChildSession({ factory, launch, prompt: "Task: Task", appendChildEvent: () => {}, writeOutputLine: () => {} });
			assert.equal(run.exitCode, 0, run.error);
			assert.equal(fs.readFileSync(markerPath, "utf-8"), RESPONSE);
			assert.match(fs.readFileSync(requestPath, "utf-8"), /Task/);
			assert.equal(fs.existsSync(sentinelPath), false);
		} finally { await factory.dispose(); }
	});
});

describe("provider child extension in the published launch contract", () => {
	it("reports the derived file it publishes, and nothing when the switch is off", async () => {
		const cwd = path.join(tempDir, "repo");
		const agentsDir = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		for (const enabled of [true, false]) {
			fs.writeFileSync(path.join(agentsDir, `provider-child-${enabled}.md`), `---\nname: provider-child-${enabled}\ndescription: Provider fixture\nmodel: ${modelId()}\nproviderChildExtensions: ${enabled}\nextensions: []\n---\nFixture.\n`);
		}
		const availableModels = [{ provider, id: "echo", fullId: modelId() }] as never;
		const on = await resolveSubagentLaunchContract({ agent: "provider-child-true", cwd, task: "Task", runId: uniqueSessionId("preflight-on"), availableModels, intercomBridge: { mode: "off" } });
		const off = await resolveSubagentLaunchContract({ agent: "provider-child-false", cwd, task: "Task", runId: uniqueSessionId("preflight-off"), availableModels, intercomBridge: { mode: "off" } });
		assert.ok(on.ok);
		assert.ok(off.ok);
		const canonical = fs.realpathSync(providerPath);
		assert.deepEqual(on.contract.tools.providerDerivedExtensions, [{ path: canonical, provider, model: modelId() }]);
		assert.equal(on.contract.tools.configuredExtensions.includes(canonical), true);
		assert.equal(on.contract.tools.extensionArgs.includes(canonical), true);
		assert.notEqual(on.contract.launchContractDigest, off.contract.launchContractDigest);
		assert.equal("providerDerivedExtensions" in off.contract.tools, false);
		assert.equal(off.contract.tools.configuredExtensions.includes(canonical), false);
		assert.equal(off.contract.tools.extensionArgs.includes(canonical), false);
	});
});

describe("provider child extension resume contract", () => {
	it("replays the recorded switch through the agent config a resume sees", () => {
		const recorded = { enabled: true, provider, path: fs.realpathSync(providerPath), model: modelId() };
		const resumed = applySteeringRecoveryAgentConfig(makeAgent("provider-child"), { providerChildExtension: recorded } as unknown as Parameters<typeof applySteeringRecoveryAgentConfig>[1]);
		assert.equal(resumed.providerChildExtensions, true);
		const withoutRecord = applySteeringRecoveryAgentConfig(makeAgent("provider-child", { providerChildExtensions: true }), {} as unknown as Parameters<typeof applySteeringRecoveryAgentConfig>[1]);
		assert.equal(withoutRecord.providerChildExtensions, undefined);
	});
});

function uniqueSessionId(label: string): string { return `${label}-${process.pid}-${providerCounter}-${tempDir.length}`; }
