import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import type { Harness } from "../harness.ts";
import { createBoundLifecycleHarness as createHarness, runToAgentIdle } from "../lifecycle-test-harness.ts";

// senpi#3864: completion is a durable root-work seal, not a turn-end guess.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

it("publishes a persisted goal completion only after agent_idle", async () => {
	// Given a real goal extension and a goal completed through its tool.
	const h = await createHarness({ persistSession: true, extensionFactories: [goalExtension] });
	harnesses.push(h);
	h.setResponses([
		fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("The work is complete."),
	]);

	// When the root finishes the goal.
	await runToAgentIdle(h, () => h.session.prompt("/goal Complete the requested change"));

	// Then one persisted seal follows idle, never settlement alone.
	expect(h.session.lifecycle).toMatchObject({
		state: "done",
		restoring: false,
		persisted: true,
		role: "root",
		completion: { kind: "goal" },
	});
	const completions = h.events.filter(
		(event) => event.type === "session_lifecycle" && event.lifecycle.state === "done",
	);
	expect(completions).toHaveLength(1);
	const completedAt = h.events.findIndex(
		(event) => event.type === "session_lifecycle" && event.lifecycle.state === "done",
	);
	expect(h.events.findIndex((event) => event.type === "agent_idle")).toBeLessThan(completedAt);
	const persistedAt = h.events.findLastIndex(
		(event) =>
			event.type === "entry_appended" &&
			event.entry.type === "custom" &&
			event.entry.customType === "session-lifecycle",
	);
	expect(persistedAt).toBeLessThan(completedAt);
	expect(h.session.lifecycle.completionId).toBe(`${h.session.sessionId}:${h.session.lifecycle.epoch}`);
});

it("opens the next epoch when an automatic wake follows a sealed reply", async () => {
	// Given a sealed root reply.
	const h = await createHarness();
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("First reply."), fauxAssistantMessage("Wake reply.")]);
	await runToAgentIdle(h, () => h.session.prompt("First request"));
	expect(h.session.lifecycle).toMatchObject({ state: "done" });
	const sealedEpoch = h.session.lifecycle.epoch;

	// When an automatic delivery starts another turn.
	await runToAgentIdle(h, () =>
		h.session.sendCustomMessage(
			{ customType: "senpi-monitor:notification", content: "Changed", display: false },
			{ triggerTurn: true },
		),
	);

	// Then its distinct epoch is automatic, although its message entered the model.
	expect(h.session.lifecycle).toMatchObject({
		state: "done",
		epoch: sealedEpoch + 1,
		epochOrigin: "automatic",
		completionId: `${h.session.sessionId}:${sealedEpoch + 1}`,
	});
});

it("keeps child custody through an atomic handoff to a queued wake", async () => {
	// Given an idle root holding a child obligation.
	const h = await createHarness();
	harnesses.push(h);
	expect(h.session.workObligations).toBeDefined();
	const child = h.session.workObligations.open("task:review", "children");

	// When the producer transfers custody synchronously.
	const queued = child.transfer("omo-wake-queue:review");

	// Then no transient terminal state or zero-custody window is observable.
	expect(h.session.workObligations.activeCount).toBe(1);
	expect(h.session.lifecycle).toMatchObject({ state: "waiting_children", waitingOn: { children: 1 } });
	expect(
		h.events.filter((event) => event.type === "session_lifecycle" && event.lifecycle.state === "done"),
	).toHaveLength(0);
	queued.close("cancelled");
});

it("rejects transfer after a producer has already released custody", async () => {
	// Given an obligation that was closed before the handoff.
	const h = await createHarness();
	harnesses.push(h);
	expect(h.session.workObligations).toBeDefined();
	const child = h.session.workObligations.open("task:review", "children");
	child.close("cancelled");

	// When the producer attempts the invalid handoff.
	const transfer = () => child.transfer("omo-wake-queue:review");

	// Then the producer bug is rejected instead of silently losing work.
	expect(transfer).toThrow();
});
