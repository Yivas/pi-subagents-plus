import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../../package.json" with { type: "json" };
import { writeAtomicJson } from "../shared/atomic-json.ts";
import { getAgentDir } from "../shared/utils.ts";

type PackageVersion = { core: number; prerelease: string[] };

// major.minor.patch as one comparable number, plus the prerelease identifiers of a SemVer version such as 0.84.0-plus.1.
const versionParts = (version: unknown): PackageVersion | undefined => {
	const match = typeof version === "string" ? /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version) : null;
	if (!match) return undefined;
	return {
		core: match.slice(1, 4).reduce((total, part) => total * 1e6 + Number(part), 0),
		prerelease: match[4]?.split(".") ?? [],
	};
};

// SemVer precedence: numeric identifiers sort below alphanumeric ones, and a version without a
// prerelease outranks any prerelease of the same core.
const comparePrereleaseIdentifiers = (left: string, right: string) => {
	const leftIsNumber = /^\d+$/.test(left);
	const rightIsNumber = /^\d+$/.test(right);
	if (leftIsNumber && rightIsNumber) return Number(left) - Number(right);
	if (leftIsNumber) return -1;
	if (rightIsNumber) return 1;
	return left < right ? -1 : left > right ? 1 : 0;
};

const compareVersions = (left: PackageVersion, right: PackageVersion) => {
	if (left.core !== right.core) return left.core - right.core;
	if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1;
	if (right.prerelease.length === 0) return -1;
	for (const [index, identifier] of left.prerelease.entries()) {
		const other = right.prerelease[index];
		if (other === undefined) return 1;
		const order = comparePrereleaseIdentifiers(identifier, other);
		if (order !== 0) return order;
	}
	return left.prerelease.length - right.prerelease.length;
};

export async function showUpgradeNotice(
	ctx: { hasUI: boolean; ui: { notify(message: string, type: "info"): void } },
	stateDir = path.join(getAgentDir(), "pi-subagents"),
	changelogPath = fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url)),
	version = packageJson.version,
): Promise<void> {
	if (!ctx.hasUI) return;
	const statePath = path.join(stateDir, "last-seen-version.json");
	const lastSeen = await fs.promises.readFile(statePath, "utf-8").then((raw) => JSON.parse(raw).version).catch(() => undefined);
	const previous = versionParts(lastSeen);
	const current = versionParts(version);
	if (current === undefined || (previous !== undefined && compareVersions(previous, current) === 0)) return;
	try {
		writeAtomicJson(statePath, { version });
	} catch {
		// Read-only installs cannot record the seen version. Without it the notice would repeat on every start, so skip it.
		return;
	}
	if (previous === undefined || compareVersions(previous, current) > 0) return;

	const bullets = (await fs.promises.readFile(changelogPath, "utf-8")).split(/^## /m).flatMap((section) => {
		const released = versionParts(/^\[([^\]]+)\]/.exec(section)?.[1]);
		if (released === undefined || compareVersions(released, previous) <= 0 || compareVersions(released, current) > 0) return [];
		const highlights = section.split(/^### /m).find((part) => part.startsWith("Highlights")) ?? "";
		return (highlights.match(/^- .*/gm) ?? []).map((bullet) => bullet.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim());
	});
	ctx.ui.notify([
		`pi-subagents-plus updated from ${lastSeen} to ${version}`,
		...bullets.slice(0, 5),
		...(bullets.length > 5 ? [`...and ${bullets.length - 5} more`] : []),
		"Changelog: https://github.com/Yivas/pi-subagents-plus/blob/main/CHANGELOG.md",
	].join("\n"), "info");
}
