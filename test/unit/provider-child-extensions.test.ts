/**
 * A child that starts without ambient extensions loses the provider its model
 * needs. The provider's extension declares the file a child must load, the
 * switch decides whether a launch uses that declaration, and a resumed run
 * replays what it launched with instead of reading a registry it may not share.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { agentDefinitionDigest } from "../../src/shared/launch-contract.ts";
import { resolveLaunchBinding } from "../../src/shared/launch-contract.ts";
import { resolvePiLaunchToolPlan } from "../../src/runs/shared/child-tool-plan.ts";
import type { ModelInfo } from "../../src/shared/model-info.ts";
import {
	extensionPathKey,
	providerChildExtensionResumeSnapshot,
	registerProviderChildExtension,
	resolveProviderChildExtension,
	resolveProviderChildExtensionLaunch,
	resumeProviderChildExtensionLaunch,
	snapshotProviderChildExtensionReference,
	snapshotProviderChildExtensionResumeSnapshot,
} from "../../src/shared/provider-child-extensions.ts";

let providerCounter = 0;
function uniqueProvider(label: string): string {
	providerCounter += 1;
	return `test-${label}-${process.pid}-${providerCounter}`;
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritGlobalContext: false,
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	};
}

const roots: string[] = [];
function fixture(fileName = "provider.mjs"): { dir: string; file: string; canonical: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-child-"));
	roots.push(dir);
	const file = path.join(dir, fileName);
	fs.writeFileSync(file, "export default () => {};\n");
	return { dir, file, canonical: fs.realpathSync(file) };
}
process.on("exit", () => {
	for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function models(provider: string, id = "echo"): ModelInfo[] {
	return [{ provider, id, fullId: `${provider}/${id}` } as unknown as ModelInfo];
}

describe("provider child extension registry", () => {
	it("canonicalizes one path per provider and disposes idempotently", () => {
		const provider = uniqueProvider("registry");
		const { file, canonical } = fixture();
		const handle = registerProviderChildExtension({ provider, path: path.join(path.dirname(file), ".", path.basename(file)), owner: "fixture" });
		try {
			assert.equal(resolveProviderChildExtension(provider)?.path, canonical);
			assert.ok(Object.isFrozen(resolveProviderChildExtension(provider)));
			// The same file from a second owner is the same declaration.
			registerProviderChildExtension({ provider, path: file, owner: "second" }).dispose();
			assert.equal(resolveProviderChildExtension(provider)?.owner, "fixture");
			handle.dispose();
			handle.dispose();
			assert.equal(resolveProviderChildExtension(provider), undefined);
		} finally {
			handle.dispose();
		}
	});

	it("names both paths and owners on conflict, whichever registration comes first", () => {
		const { file: first, canonical: firstCanonical } = fixture("first.mjs");
		const { file: second, canonical: secondCanonical } = fixture("second.mjs");
		for (const order of [["first", "second"], ["second", "first"]] as const) {
			const provider = uniqueProvider(`conflict-${order.join("-")}`);
			const byName = { first: { path: first, canonical: firstCanonical }, second: { path: second, canonical: secondCanonical } };
			const handle = registerProviderChildExtension({ provider, path: byName[order[0]].path, owner: `${order[0]}-owner` });
			try {
				assert.throws(
					() => registerProviderChildExtension({ provider, path: byName[order[1]].path, owner: `${order[1]}-owner` }),
					(error: Error) => [firstCanonical, secondCanonical, `${order[0]}-owner`, `${order[1]}-owner`].every((part) => error.message.includes(part)),
				);
			} finally {
				handle.dispose();
			}
		}
	});

	it("rejects providers, owners, and paths that could not become a child extension", () => {
		const { file } = fixture();
		assert.throws(() => registerProviderChildExtension({ provider: "bad provider", path: file, owner: "fixture" }), /provider id/);
		assert.throws(() => registerProviderChildExtension({ provider: uniqueProvider("owner"), path: file, owner: " untrimmed" }), /trimmed owner/);
		assert.throws(() => registerProviderChildExtension({ provider: uniqueProvider("relative"), path: "provider.mjs", owner: "fixture" }), /absolute path/);
		assert.throws(() => registerProviderChildExtension({ provider: uniqueProvider("missing"), path: path.join(path.dirname(file), "missing.mjs"), owner: "fixture" }), /not an importable file/);
		assert.throws(() => registerProviderChildExtension({ provider: uniqueProvider("extra"), path: file, owner: "fixture", extra: true } as never), /accepts only provider, path, and owner/);
	});

	it("rejects a serialized reference that is not exactly a provider and path", () => {
		assert.deepEqual(snapshotProviderChildExtensionReference(undefined), undefined);
		assert.equal(snapshotProviderChildExtensionReference({ provider: "p", path: "/tmp/p.mjs" })?.provider, "p");
		assert.throws(() => snapshotProviderChildExtensionReference({ provider: "p", path: "/tmp/p.mjs", owner: "o" }), /only provider and path/);
		assert.throws(() => snapshotProviderChildExtensionReference({ provider: "p", path: "relative.mjs" }), /absolute path/);
	});

	it("compares paths the way a case-insensitive filesystem does", () => {
		const key = extensionPathKey("/tmp/Provider.mjs");
		assert.equal(key, extensionPathKey("/tmp/./Provider.mjs"));
		if (process.platform === "win32") assert.equal(key, extensionPathKey("/tmp/provider.mjs"));
		else assert.notEqual(key, extensionPathKey("/tmp/provider.mjs"));
	});
});

describe("provider child extension resolution", () => {
	it("attaches the registered file only for an isolated child of this host", () => {
		const provider = uniqueProvider("resolve");
		const { canonical } = fixture();
		const handle = registerProviderChildExtension({ provider, path: canonical, owner: "fixture" });
		const availableModels = models(provider);
		const isolated = agent({ providerChildExtensions: true, extensions: [] });
		try {
			const launch = resolveProviderChildExtensionLaunch({ agent: isolated, model: `${provider}/echo`, availableModels, externalRunner: false, remoteMachine: false });
			assert.deepEqual(launch?.reference, { provider, path: canonical });
			assert.deepEqual(launch?.provenance, { provider, path: canonical, model: `${provider}/echo` });
			// Every other launch keeps upstream behaviour: nothing is attached.
			assert.equal(resolveProviderChildExtensionLaunch({ agent: agent({ extensions: [] }), model: `${provider}/echo`, availableModels, externalRunner: false, remoteMachine: false }), undefined);
			assert.equal(resolveProviderChildExtensionLaunch({ agent: agent({ providerChildExtensions: true }), model: `${provider}/echo`, availableModels, externalRunner: false, remoteMachine: false }), undefined);
			assert.equal(resolveProviderChildExtensionLaunch({ agent: isolated, model: `${provider}/echo`, availableModels, externalRunner: true, remoteMachine: false }), undefined);
			assert.equal(resolveProviderChildExtensionLaunch({ agent: isolated, model: `${provider}/echo`, availableModels, externalRunner: false, remoteMachine: true }), undefined);
			assert.equal(resolveProviderChildExtensionLaunch({ agent: isolated, model: "other-provider/missing", availableModels, externalRunner: false, remoteMachine: false }), undefined);
		} finally {
			handle.dispose();
		}
	});

	it("fails the launch instead of dropping the file under a ceiling that denies extensions", () => {
		const provider = uniqueProvider("ceiling");
		const { canonical } = fixture();
		const handle = registerProviderChildExtension({ provider, path: canonical, owner: "fixture" });
		try {
			assert.throws(
				() => resolveProviderChildExtensionLaunch({
					agent: agent({ providerChildExtensions: true }),
					model: `${provider}/echo`,
					availableModels: models(provider),
					capabilityCeiling: { version: 1, denyExtensions: true, sources: ["policy-fixture"] },
					externalRunner: false,
					remoteMachine: false,
				}),
				(error: Error) => error.message.includes("policy-fixture") && error.message.includes(canonical) && error.message.includes(`'${provider}'`),
			);
		} finally {
			handle.dispose();
		}
	});
});

describe("provider child extension resume", () => {
	it("records and replays one launch without the registry", () => {
		const provider = uniqueProvider("resume");
		const { canonical } = fixture();
		const handle = registerProviderChildExtension({ provider, path: canonical, owner: "fixture" });
		const launch = resolveProviderChildExtensionLaunch({
			agent: agent({ providerChildExtensions: true, extensions: [] }),
			model: `${provider}/echo`,
			availableModels: models(provider),
			externalRunner: false,
			remoteMachine: false,
		});
		handle.dispose();
		if (!launch) throw new Error("the launch must resolve before it can be recorded");
		const snapshot = providerChildExtensionResumeSnapshot(launch);
		assert.deepEqual(snapshot, { enabled: true, provider, path: canonical, model: `${provider}/echo` });
		assert.deepEqual(snapshotProviderChildExtensionResumeSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
		assert.deepEqual(resumeProviderChildExtensionLaunch(snapshot)?.reference, { provider, path: canonical });
		assert.equal(resumeProviderChildExtensionLaunch(undefined), undefined);
		assert.equal(resumeProviderChildExtensionLaunch({ provider, path: canonical, enabled: false }), undefined);
	});

	it("fails by name when the recorded file disappeared", () => {
		const provider = uniqueProvider("vanished");
		const { file, canonical } = fixture();
		fs.rmSync(file);
		assert.throws(
			() => resumeProviderChildExtensionLaunch({ provider, path: canonical, enabled: true }),
			(error: Error) => error.message.includes(canonical) && error.message.includes(provider) && /no longer exists/.test(error.message),
		);
	});

	it("rejects a recorded snapshot with an unexpected shape", () => {
		assert.throws(() => snapshotProviderChildExtensionResumeSnapshot({ provider: "p", path: "/tmp/p.mjs" }), /boolean enabled/);
		assert.throws(() => snapshotProviderChildExtensionResumeSnapshot({ provider: "p", path: "/tmp/p.mjs", enabled: true, owner: "o" }), /only provider, path, enabled, and model/);
		assert.throws(() => snapshotProviderChildExtensionResumeSnapshot({ provider: "p", path: "/tmp/p.mjs", enabled: true, model: "  " }), /model must be a non-empty string/);
		assert.throws(() => snapshotProviderChildExtensionResumeSnapshot({ provider: "p", path: "relative.mjs", enabled: true }), /absolute path/);
	});
});

describe("provider child extension in the launch plan", () => {
	it("adds the file to the contract lists once, after the agent's own entries", () => {
		const provider = uniqueProvider("plan");
		const { canonical } = fixture();
		const plan = resolvePiLaunchToolPlan({ extensions: [], providerChildExtension: { provider, path: canonical } });
		assert.equal(plan.configuredExtensions.includes(canonical), true);
		assert.equal(plan.extensionArgs.filter((entry) => entry === canonical).length, 1);

		const listed = resolvePiLaunchToolPlan({ subagentOnlyExtensions: [canonical], providerChildExtension: { provider, path: canonical } });
		assert.equal(listed.extensionArgs.filter((entry) => entry === canonical).length, 1);
		assert.equal(listed.configuredExtensions.filter((entry) => entry === canonical).length, 1);
	});

	it("fails closed when the ceiling denies extensions and the file is needed", () => {
		const { canonical } = fixture();
		assert.throws(
			() => resolvePiLaunchToolPlan({ capabilityCeiling: { version: 1, denyExtensions: true, sources: ["policy-fixture"] }, providerChildExtension: { provider: "any", path: canonical } }),
			/denies extensions/,
		);
	});

	for (const value of [undefined, false]) {
		it(`keeps the base definition and launch digests with providerChildExtensions=${value}`, () => {
			const target = agent({ name: "contract-worker", ...(value === undefined ? {} : { providerChildExtensions: value }) });
			const plan = resolvePiLaunchToolPlan({ tools: ["read"], extensions: [] });
			assert.deepEqual(plan.configuredExtensions, []);
			assert.deepEqual(plan.extensionArgs, plan.runtimeExtensions);
			// Calculated independently with git show 74400591:src/shared/launch-contract.ts.
			// Empty extensionArgs keep this fixture independent of the checkout's absolute path.
			const binding = resolveLaunchBinding({ agent: target, task: "task", systemPrompt: "prompt", toolPlan: { ...plan, extensionArgs: [] } });
			assert.equal(binding.definitionDigest, "bbbe4bc712145cd515697ac1ec7831c457e58fc6d80cdddd8232833341483962");
			assert.equal(binding.launchContractDigest, "a4ea67fd47202acd9a07a3336561e6f42c6d656b049779f3e3cc080f67bb10f2");
		});
	}
});

describe("provider child extension in the definition digest", () => {
	it("ignores the settings default and honors the agent's own value", () => {
		const base = agentDefinitionDigest(agent());
		assert.equal(agentDefinitionDigest(agent({ providerChildExtensions: true, providerChildExtensionsFromDefault: true })), base);
		assert.notEqual(agentDefinitionDigest(agent({ providerChildExtensions: true })), base);
		assert.equal(agentDefinitionDigest(agent({ providerChildExtensions: false })), base);
	});
});
