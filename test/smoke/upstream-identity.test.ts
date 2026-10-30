import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// Latest incorporated upstream commit, not the older v0.84.0 release tag.
// Digest fixture 74400591 has this commit as ancestor; its launch-contract/agents sources are unchanged.
// Current plus also contains its rename, upgrade notice, disabled provider bridge and reviewed fixes;
// this scenario checks their combined observable effect, not only the provider bridge.
const upstreamCommit = "a04617faa1f4d7daf631fefc10afc76412c6fe4a";
const upstreamTree = "04e1b4be1d2e92ca593626153c07969d1a08d4e6";
const archiveSha256 = "c2fb053620ca79af4c598fe0d9b3fc8776377b7b9f241fd81f6a527c92b49a1a";
const repo = path.resolve(import.meta.dirname, "../..");
const scenario = path.join(repo, "test/support/upstream-identity-scenario.mjs");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/*
 * Run: node --experimental-strip-types --test test/smoke/upstream-identity.test.ts
 * Requires Git history containing the pinned object and tar; CI obtains history with fetch-depth: 0.
 * No source download, package installation or digest fixture replacement happens in this test.
 * The candidate is archived HEAD, not uncommitted product edits. Both sides share lockfile-installed
 * Pi SDK/pi-ai (currently 1.2.0), Node, installation path, cwd and fixture inputs, sequentially.
 *
 * Boundary: the faux provider's full context, parent lifecycle/tool events, registered tool metadata
 * and every persisted session JSONL (parent and child). JSON serialization happens at observation,
 * before later mutation; session bytes are copied verbatim. No replacer, filtering or normalization.
 * Only identity.json's package name/version may differ; its path must be the same. These differences
 * belong to package identity, never model context or tool names. All compared surfaces are strict.
 *
 * This proves only this fresh foreground delegation scenario at the logged commits/runtime versions,
 * not arbitrary sessions, background work, real providers, other settings or historical SDK versions.
 * Date, performance.now, Math.random, sync randomBytes, randomUUID and Web Crypto randomness are fixed
 * before module import. OS scheduling, filesystem mtimes, process IDs and hrtime are not virtualized;
 * if any becomes observable, comparison fails and retains evidence rather than masking it.
 */

function prepareWorkspace(workspace: string): void {
	fs.rmSync(workspace, { recursive: true, force: true });
	const agentDir = path.join(workspace, "home/.pi/agent");
	const agents = path.join(workspace, "project/.pi/agents");
	fs.mkdirSync(agents, { recursive: true });
	fs.mkdirSync(path.join(agentDir, "extensions/subagent"), { recursive: true });
	fs.mkdirSync(path.join(workspace, "temp"));
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { providerChildExtensions: false } }));
	fs.writeFileSync(path.join(agentDir, "extensions/subagent/config.json"), JSON.stringify({ asyncByDefault: false, forceTopLevelAsync: false, defaultSubagentContext: "fresh", toolActivation: "eager", artifactConfig: { enabled: false } }));
	fs.writeFileSync(path.join(agents, "identity-worker.md"), "---\nname: identity-worker\ndescription: Deterministic identity worker\nmodel: identity/local\ntools: read\nextensions: []\nproviderChildExtensions: false\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nReturn IDENTITY-CHILD.\n");
}

function runScenario(packageRoot: string, workspace: string, output: string): void {
	prepareWorkspace(workspace);
	// Do not inherit the operator's Pi settings, provider tokens or extension environment.
	const env: NodeJS.ProcessEnv = {};
	for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) if (process.env[name]) env[name] = process.env[name];
	Object.assign(env, {
		HOME: path.join(workspace, "home"), USERPROFILE: path.join(workspace, "home"),
		APPDATA: path.join(workspace, "home/AppData"), LOCALAPPDATA: path.join(workspace, "home/LocalAppData"),
		PI_CODING_AGENT_DIR: path.join(workspace, "home/.pi/agent"), PI_OFFLINE: "1",
		TMPDIR: path.join(workspace, "temp"), TMP: path.join(workspace, "temp"), TEMP: path.join(workspace, "temp"),
		TZ: "UTC", LANG: "C", LC_ALL: "C", NODE_DISABLE_COMPILE_CACHE: "1",
	});
	const result = spawnSync(process.execPath, ["--experimental-strip-types", scenario, packageRoot, workspace, output], { cwd: repo, env, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
	fs.mkdirSync(output, { recursive: true });
	fs.writeFileSync(path.join(output, "stdout.log"), result.stdout ?? "");
	fs.writeFileSync(path.join(output, "stderr.log"), result.stderr ?? "");
	assert.equal(result.status, 0, `${packageRoot}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
	console.log(result.stdout.trim());
}

test("plus with fork features off is byte-identical to its upstream base in a real Pi delegation", { timeout: 150_000 }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-upstream-identity-"));
	const installation = path.join(root, "installation");
	const dependencyLink = path.join(installation, "node_modules");
	const removeInstallation = () => {
		if (fs.existsSync(dependencyLink)) fs.unlinkSync(dependencyLink);
		fs.rmSync(installation, { recursive: true, force: true });
	};
	let passed = false;
	try {
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
		assert.equal(git("rev-parse", `${upstreamCommit}^{commit}`), upstreamCommit, "base object must exist locally; use a full checkout, never a moving network ref");
		assert.equal(git("rev-parse", `${upstreamCommit}^{tree}`), upstreamTree);
		const archive = path.join(root, "upstream.tar");
		git("-c", "tar.umask=0002", "archive", "--format=tar", `--output=${archive}`, upstreamCommit);
		assert.equal(hash(fs.readFileSync(archive)), archiveSha256, "verify pinned source bytes before extracting/executing");
		const installArchive = (file: string) => {
			fs.mkdirSync(installation);
			execFileSync("tar", ["-xf", file, "-C", "installation"], { cwd: root });
			fs.symlinkSync(fs.realpathSync(path.join(repo, "node_modules")), dependencyLink, process.platform === "win32" ? "junction" : "dir");
			const { name, version } = JSON.parse(fs.readFileSync(path.join(installation, "package.json"), "utf8")) as { name: string; version: string };
			return { name, version, packageRoot: installation };
		};
		const candidateCommit = git("rev-parse", "HEAD");
		console.log(`upstream=${upstreamCommit}; plus=${candidateCommit}; Node=${process.version}`);
		git("-c", "tar.umask=0002", "archive", "--format=tar", `--output=${path.join(root, "candidate.tar")}`, candidateCommit);
		const workspace = path.join(root, "workspace");
		const baseline = path.join(root, "baseline");
		const candidate = path.join(root, "candidate");
		// A launch digest hashes absolute runtime extension paths. Control installation identity at source,
		// rather than masking a digest that later reaches the model inside a tool result.
		const baselineIdentity = installArchive("upstream.tar");
		runScenario(installation, workspace, baseline);
		removeInstallation();
		const candidateIdentity = installArchive("candidate.tar");
		runScenario(installation, workspace, candidate);

		// Closed identity allowlist: only this out-of-band receipt may differ, with exact expected values.
		// Package identity is never removed from contexts, tool names, events or session JSONL.
		for (const [output, expected] of [[baseline, baselineIdentity], [candidate, candidateIdentity]] as const) {
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, "identity.json"), "utf8")), expected);
			for (const surface of ["contexts", "events", "tools"]) assert.ok(fs.statSync(path.join(output, `${surface}.jsonl`)).size > 10, `${surface} must not be empty`);
			assert.equal(fs.statSync(path.join(output, "errors.jsonl")).size, 0);
			const session = fs.readFileSync(path.join(output, "session-0.jsonl"), "utf8");
			assert.match(session, /"type":"session"/);
			assert.match(session, /IDENTITY-PARENT-DONE/);
			const contexts = fs.readFileSync(path.join(output, "contexts.jsonl"), "utf8");
			for (const forbidden of [repo, installation, installation.replaceAll("\\", "/"), candidateIdentity.name, candidateIdentity.version]) {
				assert.ok(!contexts.includes(JSON.stringify(forbidden).slice(1, -1)), `package identity leaked to provider: ${forbidden}`);
			}
		}
		const files = (dir: string) => fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
		assert.ok(files(baseline).filter((name) => name.startsWith("session-")).length >= 2, "parent and real child must persist sessions");
		assert.deepEqual(files(candidate), files(baseline));
		const differences: string[] = [];
		for (const file of files(baseline)) {
			const before = fs.readFileSync(path.join(baseline, file));
			const after = fs.readFileSync(path.join(candidate, file));
			console.log(`${file}: upstream=${before.length} bytes ${hash(before)} plus=${after.length} bytes ${hash(after)}`);
			if (!before.equals(after)) {
				let offset = 0;
				while (offset < Math.min(before.length, after.length) && before[offset] === after[offset]) offset++;
				differences.push(`${file}: first difference at byte ${offset}; upstream=${JSON.stringify(before.subarray(Math.max(0, offset - 60), offset + 160).toString())}; plus=${JSON.stringify(after.subarray(Math.max(0, offset - 60), offset + 160).toString())}`);
			}
		}
		assert.deepEqual(differences, [], `Raw differential failed; evidence retained at ${root}`);
		passed = true;
	} finally {
		// Unlink the junction itself before recursive cleanup; never traverse the shared dependency tree.
		if (fs.existsSync(dependencyLink)) fs.unlinkSync(dependencyLink);
		if (passed) fs.rmSync(root, { recursive: true, force: true });
		else console.error(`Identity evidence retained at ${root}`);
	}
});
