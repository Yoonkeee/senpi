import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { SessionHeldError } from "../session-hold-errors.ts";
import { liveSessionHolders } from "../session-holders.ts";
import { loadEntriesFromFile, SessionManager } from "../session-manager.ts";
import { readRecordedRepositoryIdentity, readSessionCwd } from "../session-rebind.ts";
import { encodedSessionId } from "../session-sidecar-store.ts";
import {
	type BundleFile,
	MANIFEST_FILE,
	MOVE_BUNDLE_FORMAT,
	type MoveManifest,
	parseMoveId,
	parsePlainId,
	SESSION_BUNDLE_PATH,
	sha256File,
} from "./bundle.ts";
import { EXTENSION_STATE_PAYLOAD } from "./extension-state.ts";
import {
	headerSessionId,
	type MoveId,
	SESSION_RELEASED,
	SessionMovedAwayError,
	sessionOwnership,
} from "./ownership.ts";
import { withSessionMoveLock } from "./session-lock.ts";

export interface ExportSessionForMoveOptions {
	/** A session no live runtime holds: an RPC host releases it first (`release_session` reason `move`). */
	readonly sessionFile: string;
	readonly moveId: MoveId;
	readonly target: string;
	/** Queued user input the release took out of the session (`dropped.user_messages`), in order. */
	readonly droppedUserMessages: readonly string[];
	readonly bundleDir: string;
	/**
	 * What the extensions wrote at the move release, bundled as the `extension-state` payload. A function is resolved
	 * inside the move lock, right before the bundle is written (`sealedOutgoingStateDir`: the sealing attempt's folder).
	 */
	readonly extensionStateDir?: string | (() => string | undefined);
	/** Runs inside this process's move queue before anything is read; throw to refuse. */
	readonly guard?: () => void;
	/**
	 * Runs inside the cross-process move lock, right before the session is read and sealed; throw to refuse. A check on
	 * the session file's state belongs here: another generation can change it between `guard` and the lock.
	 */
	readonly lockedGuard?: () => void;
}

/**
 * Seals the session for the move (a `session_released` entry with reason `move`; from then on this device refuses
 * writes) and writes a self-verifying bundle: the session file, its extension sidecars and resident blobs, and a
 * manifest. Running it again for the same move rewrites the same bundle without a second release entry.
 */
export function exportSessionForMove(options: ExportSessionForMoveOptions): Promise<MoveManifest> {
	return withSessionMoveLock(
		options.sessionFile,
		() => {
			options.lockedGuard?.();
			return writeMoveBundle(options);
		},
		options.guard,
	);
}

/** The release that sealed the session staged extension state that is no longer on disk; bundling would lose it. */
export class MovedStateMissingError extends Error {
	constructor(dir: string) {
		super(
			`The extension state the move release staged is missing (${dir}); the session was not exported without it. Finish the move as declined to take the session back, then release it again.`,
		);
		this.name = "MovedStateMissingError";
	}
}

async function writeMoveBundle(options: ExportSessionForMoveOptions): Promise<MoveManifest> {
	const { sessionFile } = options;
	const moveId = parseMoveId(options.moveId);
	const entries = loadEntriesFromFile(sessionFile);
	// The id names the resident-blob folder copied below and must be one the receiver accepts: check it before sealing.
	const sessionId = parsePlainId(headerSessionId(entries), "session id");
	// A live runtime could still write the transcript, its sidecars or its resident blobs after the seal.
	const holders = await liveSessionHolders(sessionFile, sessionId);
	if (holders.length > 0) throw new SessionHeldError(sessionFile, holders);
	const ownership = sessionOwnership(entries);
	if (!ownership.writable && !(ownership.state === "moving" && ownership.moveId === moveId)) {
		throw new SessionMovedAwayError(sessionFile, ownership);
	}
	if (ownership.writable) {
		SessionManager.open(sessionFile).appendCustomEntry(SESSION_RELEASED, {
			reason: "move",
			move_id: moveId,
			session_id: sessionId,
			target: options.target,
			released_at: new Date().toISOString(),
		});
	}
	const stateDir =
		typeof options.extensionStateDir === "function" ? options.extensionStateDir() : options.extensionStateDir;
	if (stateDir !== undefined && !existsSync(stateDir)) throw new MovedStateMissingError(stateDir);
	const staging = `${options.bundleDir}.partial-${process.pid}`;
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(join(staging, dirname(SESSION_BUNDLE_PATH)), { recursive: true });
	copyFileSync(sessionFile, join(staging, SESSION_BUNDLE_PATH));
	const sidecars = await copySidecars(dirname(sessionFile), sessionId, staging);
	const stateFiles = await copyExtensionState(stateDir, staging);
	const manifest: MoveManifest = {
		format: MOVE_BUNDLE_FORMAT,
		moveId,
		sessionId,
		sessionFileName: basename(sessionFile),
		sourceCwd: (await readSessionCwd(sessionFile)) ?? "",
		repository: readRecordedRepositoryIdentity(sessionFile),
		session: { path: SESSION_BUNDLE_PATH, sha256: await sha256File(join(staging, SESSION_BUNDLE_PATH)) },
		sidecars,
		droppedUserMessages: [...options.droppedUserMessages],
		payloads: stateFiles.length > 0 ? [{ kind: EXTENSION_STATE_PAYLOAD, files: stateFiles }] : [],
	};
	await writeFile(join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 1)}\n`);
	rmSync(options.bundleDir, { recursive: true, force: true });
	renameSync(staging, options.bundleDir);
	return manifest;
}

async function copySidecars(sessionDir: string, sessionId: string, staging: string): Promise<BundleFile[]> {
	const sources: string[] = [];
	const extensions = join(sessionDir, "extensions");
	const sidecarName = `${encodedSessionId(sessionId)}.json`;
	if (existsSync(extensions)) {
		for (const extension of readdirSync(extensions, { withFileTypes: true })) {
			const file = join(extensions, extension.name, sidecarName);
			if (extension.isDirectory() && existsSync(file)) sources.push(file);
		}
	}
	sources.push(...filesUnder(join(sessionDir, "resident-blobs", sessionId)));
	const files: BundleFile[] = [];
	for (const source of sources) {
		const path = bundlePath("files", sessionDir, source);
		mkdirSync(dirname(join(staging, path)), { recursive: true });
		copyFileSync(source, join(staging, path));
		files.push({ path, sha256: await sha256File(join(staging, path)) });
	}
	return files;
}

async function copyExtensionState(dir: string | undefined, staging: string): Promise<BundleFile[]> {
	if (dir === undefined) return [];
	const files: BundleFile[] = [];
	for (const source of filesUnder(dir)) {
		const path = bundlePath("state", dir, source);
		mkdirSync(dirname(join(staging, path)), { recursive: true });
		copyFileSync(source, join(staging, path));
		files.push({ path, sha256: await sha256File(join(staging, path)) });
	}
	return files;
}

/** Manifest paths use `/` on every OS: the receiver strips the `files/` and `state/` prefixes by that separator. */
function bundlePath(prefix: string, from: string, source: string): string {
	return posix.join(prefix, ...relative(from, source).split(sep));
}

function filesUnder(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
	);
}
