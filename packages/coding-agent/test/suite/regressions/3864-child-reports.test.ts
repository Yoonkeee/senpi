import { afterEach, expect, it } from "vitest";
import type { LifecycleApi } from "../../../src/core/session-lifecycle-types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#3864: task identity and lifecycle generations fence every child report.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

it("ignores a stale child generation without replacing live custody", async () => {
	// Given the current child generation is still running.
	let api: LifecycleApi | undefined;
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("session_start", () => {
					api = pi.lifecycle;
				});
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	if (!api) throw new Error("pi.lifecycle must be bound before session_start");
	api.reportChild({
		taskId: "review",
		childSessionId: "child-review",
		runEpoch: 2,
		generation: 7,
		state: "running",
	});

	// When an older generation claims completion.
	api.reportChild({
		taskId: "review",
		childSessionId: "child-review",
		runEpoch: 2,
		generation: 6,
		state: "done",
		terminal: "completed",
	});

	// Then the parent still owns live child work.
	expect(h.session.lifecycle).toMatchObject({ state: "waiting_children", waitingOn: { children: 1 } });
	const reports = h.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "child-lifecycle");
	expect(reports).toHaveLength(1);
});

it("clears a terminal child when a higher run epoch reports revival", async () => {
	// Given a failed child run.
	const h = await createHarness();
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	expect(h.session.reportChildLifecycle).toBeTypeOf("function");
	h.session.reportChildLifecycle({
		taskId: "review",
		childSessionId: "child-review",
		runEpoch: 2,
		generation: 70,
		state: "failed",
		terminal: "error",
	});

	// When the runner revives it with a new epoch, even with a lower generation.
	h.session.reportChildLifecycle({
		taskId: "review",
		childSessionId: "child-review",
		runEpoch: 3,
		generation: 1,
		state: "running",
	});

	// Then old terminal state cannot release the new run's obligation.
	expect(h.session.lifecycle).toMatchObject({ state: "waiting_children", waitingOn: { children: 1 } });
});

it("drops child human waits while the runner owns automatic answers", async () => {
	// Given an automatically answered child's dialog in its registration window.
	const h = await createHarness();
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	expect(h.session.reportChildLifecycle).toBeTypeOf("function");

	// When the runner relays that child's snapshot.
	h.session.reportChildLifecycle({
		taskId: "review",
		childSessionId: "child-review",
		runEpoch: 1,
		generation: 1,
		state: "waiting_human",
		waitingOn: {
			children: 0,
			background: [],
			human: [
				{
					kind: "approval",
					originSessionId: "child-review",
					requestId: "dialog-1",
					revision: 1,
					since: "2026-10-21T00:00:00.000Z",
				},
			],
		},
	});

	// Then the root waits on the child, not a human who cannot answer it.
	expect(h.session.lifecycle).toMatchObject({
		state: "waiting_children",
		waitingOn: { children: 1, human: [] },
	});
});

it("keeps a fork as a root rather than deriving child role from file ancestry", async () => {
	// Given an ordinary fork with historical parentSession metadata.
	const h = await createHarness({
		sessionManager: SessionManager.inMemory(undefined, { parentSession: "/synthetic/parent.jsonl" }),
	});
	harnesses.push(h);

	// When its extensions finish restoring.
	await h.session.bindExtensions({ mode: "rpc" });

	// Then only spawnedBy, never ancestry, establishes child identity.
	expect(h.session.lifecycle).toMatchObject({ role: "root", rootSessionId: h.session.sessionId });
});
