import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { SessionLifecycle } from "../../../src/core/session-lifecycle-types.ts";
import { SessionEventFanout } from "../../../src/modes/rpc/session-event-fanout.ts";
import { nextSessionEvent, runToAgentIdle } from "../lifecycle-test-harness.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";
import { makeSink } from "../rpc-connection-harness.ts";

// senpi#3864: the real RPC surface owns revisions and decisions, not a client's projection.
type Fixture = Awaited<ReturnType<typeof createIdentityHarness>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup();
});

it("advertises lifecycle and returns the exact shared snapshot through get_state", async () => {
	const fixture = await createIdentityHarness();
	fixtures.push(fixture);
	await fixture.session.bindExtensions({ mode: "rpc" });
	const client = fixture.bind();
	const protocol = await client.send({ type: "get_protocol_info" });
	expect(protocol).toMatchObject({
		success: true,
		data: { capabilities: expect.arrayContaining(["session_lifecycle"]) },
	});
	const state = await client.send({ type: "get_state" });
	expect(state).toMatchObject({ success: true, data: { lifecycle: fixture.session.lifecycle } });
});

it("persists a second human client's revision before input and invalidates a standing settle request", async () => {
	const fixture = await createIdentityHarness();
	fixtures.push(fixture);
	await fixture.session.bindExtensions({ mode: "rpc" });
	const first = fixture.bind();
	const second = fixture.bind();
	await first.send({ type: "set_client_info", capabilities: ["interactive_user"] });
	await second.send({ type: "set_client_info", capabilities: ["interactive_user"] });
	const child = fixture.session.workObligations.open("task:review", "children");
	fixture.harness.setResponses([
		fauxAssistantMessage("Waiting for review."),
		fauxAssistantMessage("Review incorporated."),
	]);
	await runToAgentIdle(fixture, () => first.send({ type: "prompt", message: "Do this work." }));
	const epoch = fixture.session.lifecycle.epoch;
	expect(await first.send({ type: "request_self_settle" })).toMatchObject({
		success: true,
		data: { recorded: true, epoch, humanInputRevision: 1 },
	});
	const revision = nextSessionEvent(
		fixture.harness,
		(event) => event.type === "session_lifecycle" && event.lifecycle.humanInputRevision === 2,
	);
	await second.send({ type: "steer", message: "Consider this too." });
	expect(await revision).toMatchObject({ lifecycle: { epoch, humanInputRevision: 2, persisted: true } });
	const persisted = fixture.harness.sessionManager
		.getEntries()
		.findLast((entry) => entry.type === "custom" && entry.customType === "session-lifecycle");
	expect(persisted).toMatchObject({ data: { humanInputRevision: 2 } });
	await runToAgentIdle(fixture, () => fixture.session.prompt("Consume the queued steer.", { source: "extension" }));
	child.close("cancelled");
	expect(fixture.session.lifecycle).toMatchObject({ state: "done", humanInputRevision: 2 });
	expect(fixture.session.lifecycle.settleDecision).toBeUndefined();
});

it("broadcasts lifecycle to unattached observers and replays only the latest snapshot", async () => {
	const fanout = new SessionEventFanout();
	const observer = makeSink();
	fanout.registerConnection("observer", observer.sink);
	try {
		expect(fanout.targets("root", undefined, false, "session_lifecycle")).toContain("observer");
		const base: SessionLifecycle = {
			state: "running",
			seq: 1,
			epoch: 1,
			epochOrigin: "human",
			humanInputRevision: 1,
			selfSettleEligible: true,
			restoring: false,
			persisted: true,
			runPaused: false,
			since: "2026-10-21T00:00:00.000Z",
			role: "root",
			rootSessionId: "root",
		};
		for (const lifecycle of [base, { ...base, seq: 2, state: "done" }]) {
			const event = { type: "session_lifecycle", sessionId: "root", lifecycle };
			fanout.rememberSnapshot("root", event, `${JSON.stringify(event)}\n`);
		}
		const replayed = observer.waitFor((record) => record.type === "session_lifecycle", 10_000);
		fanout.attachConnectionToSession("observer", "root");
		expect(await replayed).toMatchObject({ lifecycle: { seq: 2, state: "done" } });
		expect(observer.messages().filter((record) => record.type === "session_lifecycle")).toHaveLength(1);
	} finally {
		fanout.unregisterConnection("observer");
	}
});

it("restores the post-steer revision when no lifecycle projection was read before restart", async () => {
	const fixture = await createIdentityHarness();
	fixtures.push(fixture);
	await fixture.session.bindExtensions({ mode: "rpc" });
	fixture.harness.setResponses([fauxAssistantMessage("Reply.")]);
	const client = fixture.bind();
	await client.send({ type: "set_client_info", capabilities: ["interactive_user"] });
	await runToAgentIdle(fixture, () => client.send({ type: "prompt", message: "Start." }));
	await client.send({ type: "steer", message: "A new instruction, not a new run." });
	await fixture.reopenAbandoned();
	await fixture.session.bindExtensions({ mode: "rpc" });
	expect(fixture.session.lifecycle.humanInputRevision).toBe(2);
});
