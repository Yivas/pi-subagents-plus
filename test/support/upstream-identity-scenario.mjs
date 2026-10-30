import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Install controls before importing either Pi or the extension. Nothing in the observer rewrites output.
const epoch = 1_800_000_000_000;
const NativeDate = Date;
globalThis.Date = class extends NativeDate {
	constructor(...args) { super(...(args.length ? args : [epoch])); }
	static now() { return epoch; }
};
Object.defineProperty(performance, "now", { value: () => 0 });
let randomState = 1;
Math.random = () => {
	randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
	return randomState / 0x100000000;
};
const crypto = createRequire(import.meta.url)("node:crypto");
let uuidSequence = 0;
crypto.randomUUID = () => `${(++uuidSequence).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const fillRandom = (array) => {
	const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
	for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	return array;
};
crypto.randomBytes = (size) => fillRandom(Buffer.alloc(size));
Object.defineProperty(crypto.webcrypto, "getRandomValues", { value: fillRandom });
Object.defineProperty(crypto.webcrypto, "randomUUID", { value: crypto.randomUUID });
syncBuiltinESMExports();

const [packageRoot, workspace, output] = process.argv.slice(2);
assert.ok(packageRoot && workspace && output);
const cwd = path.join(workspace, "project");
const agentDir = path.join(workspace, "home", ".pi", "agent");
process.chdir(cwd);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, getCurrentTools } = await import("@earendil-works/pi-ai");
const { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } = await import("@earendil-works/pi-coding-agent");
const { default: registerExtension } = await import(pathToFileURL(path.join(packageRoot, "index.ts")).href);
const runtime = { node: process.version };
for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core"]) {
	runtime[name] = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.resolve(name))), "../package.json"), "utf8")).version;
}
const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "identity.json"), JSON.stringify({ name: metadata.name, version: metadata.version, packageRoot }));
fs.writeFileSync(path.join(output, "runtime.jsonl"), `${JSON.stringify(runtime)}\n`);
console.log(JSON.stringify(runtime));

const contexts = [];
const events = [];
const tools = [];
const errors = [];
const record = (target, value) => target.push(JSON.stringify(value));
let requests = 0;
const faux = fauxProvider({ provider: "identity", models: [{ id: "local" }], tokensPerSecond: 0, minTokenSize: 100_000, maxTokenSize: 100_000 });
faux.setResponses([
	(context) => {
		record(contexts, context);
		requests++;
		assert.ok(getCurrentTools(context.messages).some((tool) => tool.name === "subagent"));
		return fauxAssistantMessage(fauxToolCall("subagent", { agent: "identity-worker", task: "Return IDENTITY-CHILD.", async: false }, { id: "identity-subagent-call" }), { stopReason: "toolUse" });
	},
	(context) => {
		record(contexts, context);
		requests++;
		assert.match(JSON.stringify(context.messages), /Return IDENTITY-CHILD/);
		return fauxAssistantMessage("IDENTITY-CHILD");
	},
	(context) => {
		record(contexts, context);
		requests++;
		assert.ok(context.messages.some((message) => message.role === "toolResult" && message.toolName === "subagent" && !message.isError && JSON.stringify(message).includes("IDENTITY-CHILD")), "subagent must return the real child's response");
		return fauxAssistantMessage("IDENTITY-PARENT-DONE");
	},
]);

// The same observer is the last inline extension in both processes.
const observer = (pi) => {
	for (const name of ["session_start", "before_agent_start", "agent_start", "turn_start", "tool_call", "tool_execution_start", "tool_execution_end", "tool_result", "turn_end", "agent_end", "session_shutdown"]) {
		pi.on(name, (event) => { record(events, event); });
	}
	pi.on("session_start", () => { record(tools, pi.getAllTools()); });
};
const settingsManager = SettingsManager.inMemory({ subagents: { providerChildExtensions: false } });
const resourceLoader = new DefaultResourceLoader({
	cwd, agentDir, settingsManager,
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	systemPrompt: "Deterministic identity scenario.",
	extensionFactories: [registerExtension, (pi) => pi.registerProvider(faux.provider), observer],
});
await resourceLoader.reload();
assert.deepEqual(resourceLoader.getExtensions().errors, []);
const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
const sessionManager = SessionManager.create(cwd, path.join(workspace, "sessions"));
const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager, noTools: "builtin" });
session.extensionRunner.onError((error) => { record(errors, error); });
try {
	await session.bindExtensions({});
	await session.prompt("Delegate to identity-worker and report the result.");
} finally {
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
	for (const [name, lines] of Object.entries({ contexts, events, tools, errors })) fs.writeFileSync(path.join(output, `${name}.jsonl`), lines.join("\n") + (lines.length ? "\n" : ""));
	const sessionFiles = fs.readdirSync(path.join(workspace, "sessions"), { recursive: true }).filter((file) => String(file).endsWith(".jsonl")).sort();
	for (const [index, file] of sessionFiles.entries()) fs.copyFileSync(path.join(workspace, "sessions", file), path.join(output, `session-${index}.jsonl`));
}
assert.equal(requests, 3, "parent request, real child request, parent result request");
assert.deepEqual(errors, []);
assert.equal(session.messages.at(-1)?.role, "assistant");
assert.match(JSON.stringify(session.messages.at(-1)), /IDENTITY-PARENT-DONE/);
assert.ok(events.some((line) => line.includes('"type":"tool_execution_end"') && line.includes('"toolName":"subagent"') && line.includes("IDENTITY-CHILD")));
assert.ok(contexts.length && events.length && tools.length);
console.log("Verified: 3 provider requests, successful subagent execution, real child response, parent completion.");
