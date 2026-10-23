import type { ChildLifecycleReport, LifecycleWaits, SessionLifecycleState } from "./session-lifecycle-types.ts";
import type { SessionEntry } from "./session-manager.ts";
import { isRecord } from "./work-custody-record.ts";

export interface ChildLifecycleStore {
	readonly entries: readonly SessionEntry[];
	append(report: ChildLifecycleReport): void;
	changed(): void;
}

export class LifecycleChildren {
	private readonly records = new Map<string, ChildLifecycleReport>();
	private readonly store: ChildLifecycleStore;
	constructor(store: ChildLifecycleStore) {
		this.store = store;
		for (const entry of store.entries) {
			if (entry.type !== "custom" || entry.customType !== "child-lifecycle") continue;
			const report = readChildReport(entry.data);
			if (report) this.accept(report, false);
		}
	}

	get reports(): readonly ChildLifecycleReport[] {
		return [...this.records.values()];
	}

	get activeCount(): number {
		return this.reports.filter((report) => report.terminal === undefined).length;
	}

	report(report: ChildLifecycleReport): void {
		const parsed = readChildReport(report);
		if (!parsed) throw new Error("Invalid child lifecycle report");
		if (!this.accept(parsed, true)) return;
		this.store.changed();
	}

	private accept(report: ChildLifecycleReport, persist: boolean): boolean {
		const previous = this.records.get(report.taskId);
		if (
			previous &&
			(report.runEpoch < previous.runEpoch ||
				(report.runEpoch === previous.runEpoch &&
					(previous.terminal !== undefined || report.generation <= previous.generation)))
		)
			return false;
		// A terminal is final within its run epoch; only a new run epoch replaces it.
		// Human waits remain runner-owned until an explicit child-to-human bridge exists.
		const accepted: ChildLifecycleReport = {
			...report,
			...(report.waitingOn ? { waitingOn: { ...report.waitingOn, human: [] } } : {}),
		};
		if (persist) this.store.append(accepted);
		this.records.set(report.taskId, accepted);
		return true;
	}
}

export function readLifecycleState(value: unknown): SessionLifecycleState | undefined {
	switch (value) {
		case "running":
		case "waiting_children":
		case "waiting_background":
		case "waiting_human":
		case "paused":
		case "held":
		case "done":
		case "failed":
		case "cancelled":
			return value;
		default:
			return undefined;
	}
}

function readChildReport(value: unknown): ChildLifecycleReport | undefined {
	if (!isRecord(value)) return undefined;
	const state = readLifecycleState(value.state);
	if (
		!state ||
		typeof value.taskId !== "string" ||
		typeof value.childSessionId !== "string" ||
		typeof value.runEpoch !== "number" ||
		!Number.isSafeInteger(value.runEpoch) ||
		value.runEpoch < 0 ||
		typeof value.generation !== "number" ||
		!Number.isSafeInteger(value.generation) ||
		value.generation < 0
	)
		return undefined;
	const terminal = readTerminal(value.terminal);
	let waitingOn: LifecycleWaits | undefined;
	if (isRecord(value.waitingOn) && typeof value.waitingOn.children === "number") {
		const background: LifecycleWaits["background"][number][] = [];
		if (Array.isArray(value.waitingOn.background))
			for (const item of value.waitingOn.background) {
				if (!isRecord(item) || typeof item.source !== "string" || typeof item.activeCount !== "number") continue;
				background.push({
					source: item.source,
					activeCount: item.activeCount,
					...(typeof item.retryAtMs === "number" ? { retryAtMs: item.retryAtMs } : {}),
				});
			}
		waitingOn = { children: value.waitingOn.children, background, human: [] };
	}
	return {
		taskId: value.taskId,
		childSessionId: value.childSessionId,
		runEpoch: value.runEpoch,
		generation: value.generation,
		state,
		...(waitingOn ? { waitingOn } : {}),
		...(terminal === undefined ? {} : { terminal }),
	};
}

function readTerminal(value: unknown): ChildLifecycleReport["terminal"] {
	switch (value) {
		case "completed":
		case "error":
		case "lost":
		case "interrupted":
		case "cancelled":
			return value;
		default:
			return undefined;
	}
}
