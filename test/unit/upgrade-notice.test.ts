import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { showUpgradeNotice } from "../../src/extension/upgrade-notice.ts";

const CHANGELOG = "## [Unreleased]\n\n### Highlights\n\n- Unreleased.\n\n## [0.3.0]\n\n### Highlights\n\n- Newest [highlight](https://example.com).\n\n### Fixed\n\n- Not a highlight.\n\n## [0.2.0]\n\n### Highlights\n\n- Middle highlight.\n\n## [0.1.0]\n\n### Highlights\n\n- Already seen.\n";

const PRERELEASE_CHANGELOG = "## [0.84.0-plus.2]\n\n### Highlights\n\n- Second fork release.\n\n## [0.84.0-plus.1]\n\n### Highlights\n\n- First fork release.\n\n## [0.83.1]\n\n### Highlights\n\n- Already seen.\n";

it("announces each upgrade's highlights once, only in a UI session", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-upgrade-notice-"));
	const changelog = path.join(dir, "CHANGELOG.md");
	fs.writeFileSync(changelog, CHANGELOG);
	const notices: string[] = [];
	const start = (version: string, hasUI = true) => showUpgradeNotice({ hasUI, ui: { notify: (message: string) => notices.push(message) } }, dir, changelog, version);
	try {
		await start("0.1.0", false);
		assert.equal(fs.existsSync(path.join(dir, "last-seen-version.json")), false);
		await start("0.1.0");
		await start("0.1.0");
		assert.deepEqual(notices, []);
		await start("0.3.0");
		await start("0.3.0");
		assert.deepEqual(notices, ["pi-subagents-plus updated from 0.1.0 to 0.3.0\n- Newest highlight.\n- Middle highlight.\nChangelog: https://github.com/Yivas/pi-subagents-plus/blob/main/CHANGELOG.md"]);
		fs.writeFileSync(path.join(dir, "last-seen-version.json"), "{");
		await start("0.3.0");
		assert.deepEqual([notices.length, JSON.parse(fs.readFileSync(path.join(dir, "last-seen-version.json"), "utf-8"))], [1, { version: "0.3.0" }]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

it("announces versions with a prerelease suffix and records them as seen", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-upgrade-notice-"));
	const changelog = path.join(dir, "CHANGELOG.md");
	fs.writeFileSync(changelog, PRERELEASE_CHANGELOG);
	const statePath = path.join(dir, "last-seen-version.json");
	fs.writeFileSync(statePath, JSON.stringify({ version: "0.83.1" }));
	const notices: string[] = [];
	const start = (version: string) => showUpgradeNotice({ hasUI: true, ui: { notify: (message: string) => notices.push(message) } }, dir, changelog, version);
	try {
		await start("0.84.0-plus.1");
		await start("0.84.0-plus.1");
		await start("0.84.0-plus.2");
		assert.deepEqual(notices, [
			"pi-subagents-plus updated from 0.83.1 to 0.84.0-plus.1\n- First fork release.\nChangelog: https://github.com/Yivas/pi-subagents-plus/blob/main/CHANGELOG.md",
			"pi-subagents-plus updated from 0.84.0-plus.1 to 0.84.0-plus.2\n- Second fork release.\nChangelog: https://github.com/Yivas/pi-subagents-plus/blob/main/CHANGELOG.md",
		]);
		assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf-8")), { version: "0.84.0-plus.2" });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

it("orders prerelease identifiers by SemVer precedence", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-upgrade-notice-"));
	const changelog = path.join(dir, "CHANGELOG.md");
	fs.writeFileSync(changelog, "## [0.84.0-plus.10]\n\n### Highlights\n\n- Tenth fork release.\n\n## [0.84.0-plus.9]\n\n### Highlights\n\n- Ninth fork release.\n\n## [0.84.0-alpha.1]\n\n### Highlights\n\n- Alpha one.\n\n## [0.84.0-alpha]\n\n### Highlights\n\n- Alpha.\n");
	const statePath = path.join(dir, "last-seen-version.json");
	const notices: string[] = [];
	const seen = (version: string) => fs.writeFileSync(statePath, JSON.stringify({ version }));
	const start = (version: string) => showUpgradeNotice({ hasUI: true, ui: { notify: (message: string) => notices.push(message) } }, dir, changelog, version);
	try {
		seen("0.84.0-alpha");
		await start("0.84.0-alpha.1");
		assert.deepEqual(notices, ["pi-subagents-plus updated from 0.84.0-alpha to 0.84.0-alpha.1\n- Alpha one.\nChangelog: https://github.com/Yivas/pi-subagents-plus/blob/main/CHANGELOG.md"], "more identifiers outrank fewer");
		notices.length = 0;
		seen("0.84.0-alpha.1");
		await start("0.84.0-alpha");
		assert.deepEqual(notices, [], "fewer identifiers are an older version");
		seen("0.84.0-plus.9");
		await start("0.84.0-plus.10");
		assert.deepEqual(notices, ["pi-subagents-plus updated from 0.84.0-plus.9 to 0.84.0-plus.10\n- Tenth fork release.\nChangelog: https://github.com/Yivas/pi-subagents-plus/blob/main/CHANGELOG.md"], "numeric identifiers compare as numbers");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

it("starts quietly when the seen version cannot be recorded", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-upgrade-notice-"));
	const changelog = path.join(dir, "CHANGELOG.md");
	fs.writeFileSync(changelog, CHANGELOG);
	fs.writeFileSync(path.join(dir, "not-a-directory"), "");
	const notices: string[] = [];
	try {
		await showUpgradeNotice({ hasUI: true, ui: { notify: (message: string) => notices.push(message) } }, path.join(dir, "not-a-directory", "pi-subagents"), changelog, "0.3.0");
		assert.deepEqual(notices, []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
