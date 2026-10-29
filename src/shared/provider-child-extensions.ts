/**
 * Cooperative provider support for children: the extension that serves a model
 * provider declares which file a child must load to keep that provider, and a
 * launch that starts without ambient extensions loads exactly that file.
 *
 * Pi has no public way to ask which extension registered a provider, and
 * loading an extension runs all of it, so the provider's extension is the only
 * party that can name a faithful file: the whole extension, or a dedicated
 * entry with the hooks the provider needs.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { findModelInfo, type ModelInfo } from "./model-info.ts";

const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_OWNER_LENGTH = 256;
const MAX_PATH_BYTES = 4096;
const REGISTRY_KEY = Symbol.for("pi-subagents.provider-child-extensions.v1");

export interface ProviderChildExtensionReference {
	/** Provider id the child model registry reports for the model, e.g. the id a provider was registered under. */
	provider: string;
	/** Canonical absolute path of a file a child loads as an extension. */
	path: string;
}

export interface ProviderChildExtension extends ProviderChildExtensionReference {
	/** Registering extension; it is named in conflicts and diagnostics. */
	owner: string;
}

export interface RegisterProviderChildExtensionInput {
	provider: string;
	path: string;
	owner: string;
}

export interface ProviderChildExtensionRegistration {
	dispose(): void;
}

interface Registry {
	version: 1;
	byProvider: Map<string, ProviderChildExtension>;
}

function registry(): Registry {
	const root = globalThis as Record<PropertyKey, unknown>;
	const existing = root[REGISTRY_KEY];
	if (existing === undefined) {
		const created: Registry = { version: 1, byProvider: new Map() };
		root[REGISTRY_KEY] = created;
		return created;
	}
	if (!existing || typeof existing !== "object" || !("version" in existing) || existing.version !== 1 || !("byProvider" in existing) || !(existing.byProvider instanceof Map)) {
		throw new Error("Malformed or unsupported provider child extension registry.");
	}
	return { version: 1, byProvider: existing.byProvider };
}

function assertProviderChildExtensionProvider(value: unknown, label: string): string {
	if (typeof value !== "string" || !PROVIDER_PATTERN.test(value)) {
		throw new Error(`${label} requires a provider id of at most 128 characters: letters, digits, dot, underscore, or hyphen.`);
	}
	return value;
}

function assertProviderChildExtensionPath(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) {
		throw new Error(`${label} requires a non-empty absolute path of at most ${MAX_PATH_BYTES} bytes without NUL.`);
	}
	if (!path.isAbsolute(value)) throw new Error(`${label} requires a non-empty absolute path of at most ${MAX_PATH_BYTES} bytes without NUL.`);
	return value;
}

/** The comparison the plan uses to notice that an agent already lists the same file. */
export function extensionPathKey(extensionPath: string): string {
	const normalized = path.normalize(extensionPath);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Declare the extension a child must load for one provider. Canonicalizing
 * here, once, means every later comparison and every launch sees the same
 * file identity, and a path that cannot be imported fails at registration
 * instead of in a child.
 */
export function registerProviderChildExtension(input: RegisterProviderChildExtensionInput): ProviderChildExtensionRegistration {
	if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "provider" && key !== "path" && key !== "owner")) {
		throw new Error("Provider child extension registration accepts only provider, path, and owner.");
	}
	const provider = assertProviderChildExtensionProvider(input.provider, "Provider child extension registration");
	if (typeof input.owner !== "string" || !input.owner.trim() || input.owner.trim() !== input.owner || input.owner.length > MAX_OWNER_LENGTH || input.owner.includes("\0")) {
		throw new Error(`Provider child extension registration requires a trimmed owner of at most ${MAX_OWNER_LENGTH} characters without NUL.`);
	}
	const rawPath = assertProviderChildExtensionPath(input.path, "Provider child extension registration");
	let extensionPath: string;
	try {
		extensionPath = fs.realpathSync(path.resolve(rawPath));
		if (!fs.statSync(extensionPath).isFile()) throw new Error("not a file");
	} catch (error) {
		throw new Error(`Provider child extension registration for provider '${provider}' is not an importable file: ${error instanceof Error ? error.message : String(error)}`);
	}
	const entry: ProviderChildExtension = Object.freeze({ provider, path: extensionPath, owner: input.owner });
	const store = registry();
	const existing = store.byProvider.get(provider);
	if (existing) {
		if (existing.path !== extensionPath) {
			throw new Error(`Provider '${provider}' already has child extension '${existing.path}' registered by '${existing.owner}', so '${input.owner}' cannot register '${extensionPath}'. Register one child extension path per provider.`);
		}
		// The first registration owns the entry, so reloading an extension never removes another owner's declaration.
		return { dispose() {} };
	}
	store.byProvider.set(provider, entry);
	return {
		dispose() {
			if (store.byProvider.get(provider) === entry) store.byProvider.delete(provider);
		},
	};
}

export function resolveProviderChildExtension(provider: string | undefined): ProviderChildExtension | undefined {
	if (!provider) return undefined;
	return registry().byProvider.get(provider);
}

/**
 * Validate a reference that crossed a process boundary. Registration already
 * canonicalized the path, so a launch only re-checks the shape before an
 * absolute path becomes an extension a child loads.
 */
export function snapshotProviderChildExtensionReference(value: unknown, label = "Provider child extension"): ProviderChildExtensionReference | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object with provider and path.`);
	const entry = value as Record<string, unknown>;
	for (const key of Object.keys(entry)) {
		if (key !== "provider" && key !== "path") throw new Error(`${label} accepts only provider and path.`);
	}
	return Object.freeze({
		provider: assertProviderChildExtensionProvider(entry.provider, label),
		path: assertProviderChildExtensionPath(entry.path, label),
	});
}

/**
 * The switch and the explicit list that decide one launch. The global
 * `subagents.providerChildExtensions` default reaches this value through the
 * agent, so a launch never re-reads settings.
 */
export interface ProviderChildExtensionAgent {
	providerChildExtensions?: boolean;
	extensions?: string[];
}

/**
 * A child keeps only the files its launch names when the agent lists
 * extensions or a ceiling denies them. One definition, because the plan and the
 * provider resolution must agree on it.
 */
export function childDisablesAmbientExtensions(input: {
	extensions?: string[];
	capabilityCeiling?: { denyExtensions?: boolean };
}): boolean {
	return input.capabilityCeiling?.denyExtensions === true || input.extensions !== undefined;
}

/**
 * A ceiling that denies extensions cannot drop a file its provider needs: the
 * child would start without the provider that serves its model, so the launch
 * fails instead of pretending the restriction held.
 */
export function assertProviderChildExtensionNotDenied(
	reference: ProviderChildExtensionReference,
	capabilityCeiling: { denyExtensions?: boolean; sources: string[] } | undefined,
): void {
	if (!capabilityCeiling?.denyExtensions) return;
	throw new Error(
		`Capability ceiling from ${capabilityCeiling.sources.join(", ") || "unknown source"} denies extensions, but provider '${reference.provider}' registered child extension '${reference.path}'. Relax the ceiling or use a model whose provider needs no extension in the child.`,
	);
}

/** Which model's provider derived the file. Published authority, never agent-supplied. */
export interface ProviderChildExtensionProvenance {
	path: string;
	provider: string;
	model: string;
}

export interface ProviderChildExtensionLaunch {
	/** The reference a launch forwards; the plan re-validates exactly these fields. */
	reference: ProviderChildExtensionReference;
	provenance: ProviderChildExtensionProvenance;
}

export interface ResolveProviderChildExtensionLaunchInput {
	agent: ProviderChildExtensionAgent;
	/** Model the child will run, with any thinking suffix. */
	model?: string;
	availableModels?: readonly ModelInfo[];
	preferredProvider?: string;
	capabilityCeiling?: { denyExtensions?: boolean; sources: string[] };
	/** A runner outside this process cannot load a file from this filesystem. */
	externalRunner: boolean;
	/** A saved machine runs the child on another host, with its own file system. */
	remoteMachine: boolean;
}

/**
 * The single place that decides whether a launch attaches its provider's child
 * extension: switch, host, ceiling, whether the child starts without ambient
 * extensions, and the registry entry for the model's provider. Undefined and a
 * launch forwards nothing, which is every launch upstream performs.
 */
export function resolveProviderChildExtensionLaunch(input: ResolveProviderChildExtensionLaunchInput): ProviderChildExtensionLaunch | undefined {
	if (input.agent.providerChildExtensions !== true) return undefined;
	if (input.externalRunner || input.remoteMachine) return undefined;
	if (!input.model) return undefined;
	const model = findModelInfo(input.model, input.availableModels, input.preferredProvider);
	const entry = model ? resolveProviderChildExtension(model.provider) : undefined;
	if (!entry) return undefined;
	// A child that keeps ambient extensions loads the provider's own extension anyway.
	if (!childDisablesAmbientExtensions({ extensions: input.agent.extensions, capabilityCeiling: input.capabilityCeiling })) return undefined;
	const reference = Object.freeze({ provider: entry.provider, path: entry.path });
	assertProviderChildExtensionNotDenied(reference, input.capabilityCeiling);
	return {
		reference,
		provenance: Object.freeze({ path: entry.path, provider: entry.provider, model: input.model }),
	};
}

/**
 * What a run recorded about this resolution, so a resumed launch replays it
 * instead of re-reading the switch, the settings, or a registry this process
 * does not have. Absence of the field means the run never attached one.
 */
export interface ProviderChildExtensionResumeSnapshot extends ProviderChildExtensionReference {
	/** The switch as it stood at launch, so the resumed definition digest does not follow current settings. */
	enabled: boolean;
	model?: string;
}

export function snapshotProviderChildExtensionResumeSnapshot(value: unknown, label = "Provider child extension resume snapshot"): ProviderChildExtensionResumeSnapshot | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object with provider and path.`);
	const entry = value as Record<string, unknown>;
	for (const key of Object.keys(entry)) {
		if (key !== "provider" && key !== "path" && key !== "enabled" && key !== "model") throw new Error(`${label} accepts only provider, path, enabled, and model.`);
	}
	if (typeof entry.enabled !== "boolean") throw new Error(`${label} requires a boolean enabled field.`);
	if (entry.model !== undefined && (typeof entry.model !== "string" || !entry.model.trim())) throw new Error(`${label} model must be a non-empty string when present.`);
	const reference = snapshotProviderChildExtensionReference({ provider: entry.provider, path: entry.path }, label)!;
	return Object.freeze({ ...reference, enabled: entry.enabled, ...(entry.model === undefined ? {} : { model: entry.model as string }) });
}

/**
 * Record what a launch resolved, so a resume replays it instead of re-reading
 * settings or a registry this process does not have.
 */
export function providerChildExtensionResumeSnapshot(launch: ProviderChildExtensionLaunch | undefined): ProviderChildExtensionResumeSnapshot | undefined {
	if (!launch) return undefined;
	return Object.freeze({ enabled: true, provider: launch.reference.provider, path: launch.reference.path, model: launch.provenance.model });
}

/**
 * Replay a recorded resolution. A path that no longer exists fails the resume
 * by name: dropping it would launch a child without the provider it recorded.
 */
export function resumeProviderChildExtensionLaunch(snapshot: ProviderChildExtensionResumeSnapshot | undefined): ProviderChildExtensionLaunch | undefined {
	if (!snapshot) return undefined;
	if (!snapshot.enabled) return undefined;
	let isFile = false;
	try {
		isFile = fs.statSync(snapshot.path).isFile();
	} catch {
		isFile = false;
	}
	if (!isFile) {
		throw new Error(`Cannot resume with provider child extension '${snapshot.path}': the file recorded for provider '${snapshot.provider}' no longer exists. Re-register that provider's extension or start a new run.`);
	}
	const reference = Object.freeze({ provider: snapshot.provider, path: snapshot.path });
	return {
		reference,
		provenance: Object.freeze({ path: snapshot.path, provider: snapshot.provider, model: snapshot.model ?? "" }),
	};
}
