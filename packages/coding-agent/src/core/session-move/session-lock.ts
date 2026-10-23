import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { withSessionMoveLock as withHolderMoveLock } from "../session-holders.ts";
import { loadEntriesFromFile } from "../session-manager.ts";
import { serializeByKey } from "../session-sidecar-store.ts";
import { headerSessionId } from "./ownership.ts";

export function realSessionPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch {
		return absolute;
	}
}

const lockKey = (resolvedPath: string): string => `session-move:${resolvedPath}`;

export const moveLockKey = (sessionFile: string): string => lockKey(realSessionPath(sessionFile));

/**
 * Runs the sender's steps of a move (export, finish) one at a time per session file, across processes too.
 *
 * - In this process, steps queue per file, so a second `finish` for the same move starts after the first has settled
 *   and finds the move already closed: the queued input it hands back is re-queued once, never twice.
 * - Across processes (two host generations on one agent directory), the step holds the session's move lock, which
 *   proves no live process holds the session (`SessionHeldError`, code `ESESSIONHELD`) and makes every later
 *   `holdSessionFile` wait or refuse while the step runs.
 * - `guard` runs first inside the queue, so a caller's own check (for example "not open on this host") sees the
 *   state the step will act on.
 */
export function withSessionMoveLock<T>(sessionFile: string, step: () => Promise<T>, guard?: () => void): Promise<T> {
	const path = realSessionPath(sessionFile);
	return serializeByKey(lockKey(path), async () => {
		guard?.();
		const sessionId = headerSessionId(loadEntriesFromFile(path));
		return sessionId === undefined ? step() : withHolderMoveLock(path, sessionId, step);
	});
}
