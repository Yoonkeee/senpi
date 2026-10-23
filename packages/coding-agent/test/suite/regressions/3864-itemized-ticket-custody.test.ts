import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SendMessageItem } from "../../../src/core/extensions/types.ts";
import { DeliveryTicketRefused } from "../../../src/core/work-obligations.ts";
import { type ResumeFixture, resumeFixture, settle, settlesWithin } from "./issue-3811-resume-support.ts";

const WAKE = "omo-senpi:wake";
const items: readonly SendMessageItem[] = [
	{ itemId: "a", producer: "task", content: "Task A finished" },
	{ itemId: "b", producer: "task", content: "Task B finished" },
];

async function textFixture(): Promise<ResumeFixture> {
	const fixture = await resumeFixture();
	fixture.h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	return fixture;
}

function sendWithTicket(fixture: ResumeFixture, ticket: string) {
	return fixture
		.api()
		.sendMessage(
			{ customType: WAKE, content: "Task A finished\n\nTask B finished", display: false },
			{ triggerTurn: true, deliverAs: "followUp", items, ticket },
		);
}

function openTicket(fixture: ResumeFixture, key: string): string {
	return fixture.api().lifecycle.obligations.open(key, "children").ticket();
}

function ticketOpen(fixture: ResumeFixture, ticket: string): boolean {
	return fixture.h.session.workObligations.active.some((record) => record.ticketId === ticket);
}

function persistedNotices(fixture: ResumeFixture): number {
	return fixture.h
		.eventsOfType("session_notice")
		.filter((event) => event.disposition === "notice_persisted")
		.reduce((sum, event) => sum + event.noticeIds.length, 0);
}

/** Resolves at the end of the next agent run; subscribe before the action that starts it. */
function nextRunEnd(fixture: ResumeFixture): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = fixture.h.session.subscribe((event) => {
			if (event.type !== "agent_end") return;
			unsubscribe();
			resolve();
		});
	});
}

/** Resolves once the ticket's delivery released it: the queued message is in custody, no longer being delivered. */
function deliveryEnded(fixture: ResumeFixture, ticket: string): Promise<void> {
	const obligations = fixture.h.session.workObligations;
	const endDelivery = obligations.endDelivery.bind(obligations);
	const ended = Promise.withResolvers<void>();
	obligations.endDelivery = (ticketId) => {
		endDelivery(ticketId);
		if (ticketId === ticket) ended.resolve();
	};
	return ended.promise;
}

// senpi#3864 x senpi#3811: an itemized send carrying a delivery ticket settles that ticket exactly once.
describe("itemized sendMessage with a delivery ticket", () => {
	const fixtures: ResumeFixture[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) {
			await fixture.h.session.abort();
			fixture.h.cleanup();
		}
	});

	it("hands the ticket to the held notices, so the session is done once the resume delivers them", async () => {
		// Given a stopped session and a producer ticket for the batch
		const fixture = await textFixture();
		fixtures.push(fixture);
		await fixture.h.session.stop();
		const ticket = openTicket(fixture, "result:batch");

		// When the batch is sent with that ticket while the Stop holds it
		const receipts = await sendWithTicket(fixture, ticket);

		// Then every item is a held notice and the ticket is no longer open work
		expect(receipts?.map((receipt) => receipt.disposition)).toEqual(["notice_persisted", "notice_persisted"]);
		expect(ticketOpen(fixture, ticket)).toBe(false);

		// When the person resumes and the notices are delivered
		await fixture.h.session.resumeSession();
		await settle(fixture);

		// Then nothing is owed any more
		expect(fixture.h.faux.state.callCount).toBe(1);
		expect(fixture.h.session.workObligations.activeCount).toBe(0);
		expect(fixture.h.session.lifecycle.state).toBe("done");
	});

	it("keeps the ticket on a batch a Stop dropped during admission, and settles it once", async () => {
		// Given a batch whose admission is overtaken by a Stop while its header is written
		const fixture = await textFixture();
		fixtures.push(fixture);
		const ticket = openTicket(fixture, "result:batch");
		const manager = fixture.h.sessionManager;
		const persist = manager.persistHeaderNow.bind(manager);
		let stopped = false;
		manager.persistHeaderNow = async () => {
			if (!stopped) {
				stopped = true;
				await fixture.h.session.stop();
			}
			return persist();
		};

		// When the batch is sent with that ticket
		const receipts = await sendWithTicket(fixture, ticket);

		// Then the dropped batch is decided again under the Stop: held, not rejected, and its ticket is not left open
		expect(stopped).toBe(true);
		expect(receipts?.map((receipt) => receipt.disposition)).toEqual(["notice_persisted", "notice_persisted"]);
		expect(ticketOpen(fixture, ticket)).toBe(false);

		// When the person resumes
		await fixture.h.session.resumeSession();
		await settle(fixture);

		// Then the session is done with nothing owed
		expect(fixture.h.session.workObligations.activeCount).toBe(0);
		expect(fixture.h.session.lifecycle.state).toBe("done");
	});

	it("writes a held batch's notices once when the same ticketed batch is sent again while stopped", async () => {
		// Given a stopped session whose ticketed batch is already held
		const fixture = await textFixture();
		fixtures.push(fixture);
		await fixture.h.session.stop();
		const ticket = openTicket(fixture, "result:batch");
		await sendWithTicket(fixture, ticket);
		expect(persistedNotices(fixture)).toBe(2);

		// When the producer retries the same batch with the same ticket
		const retry = sendWithTicket(fixture, ticket);

		// Then the retry is refused before anything is written, and resume delivers each item once
		await expect(retry).rejects.toBeInstanceOf(DeliveryTicketRefused);
		expect(persistedNotices(fixture)).toBe(2);
		await fixture.h.session.resumeSession();
		await settle(fixture);
		const delivered = JSON.stringify(fixture.h.faux.getCallLog().at(-1)?.context.messages);
		expect(delivered.split("Task A finished").length - 1).toBe(1);
	});

	it("writes nothing and rejects when a held batch carries an unknown ticket", async () => {
		// Given a stopped session
		const fixture = await textFixture();
		fixtures.push(fixture);
		await fixture.h.session.stop();

		// When a batch is sent with a ticket custody never issued
		const sent = sendWithTicket(fixture, "never-issued");

		// Then the promise rejects and no item is kept
		await expect(sent).rejects.toBeInstanceOf(DeliveryTicketRefused);
		expect(persistedNotices(fixture)).toBe(0);
	});

	it("delivers a batch a plain abort (Esc) dropped during admission and settles its ticket", async () => {
		// Given a batch whose admission is overtaken by a user abort while its header is written
		const fixture = await textFixture();
		fixtures.push(fixture);
		const ticket = openTicket(fixture, "result:batch");
		const manager = fixture.h.sessionManager;
		const persist = manager.persistHeaderNow.bind(manager);
		let aborted = false;
		manager.persistHeaderNow = async () => {
			if (!aborted) {
				aborted = true;
				await fixture.h.session.abort();
			}
			return persist();
		};

		// When the batch is sent with that ticket, and the turn it starts ends
		const runEnded = nextRunEnd(fixture);
		const receipts = await sendWithTicket(fixture, ticket);
		await settlesWithin(runEnded, "the re-admitted batch's turn");
		await settle(fixture);

		// Then nothing holds it: it is decided again, delivered, and its ticket is settled
		expect(aborted).toBe(true);
		expect(receipts?.map((receipt) => receipt.disposition)).toEqual(["message_persisted", "message_persisted"]);
		expect(ticketOpen(fixture, ticket)).toBe(false);
		expect(fixture.h.session.lifecycle.state).toBe("done");
	});

	it("settles a re-send whose ticket's message is still queued with the queued message's receipts", async () => {
		// Given a running turn and a ticketed batch queued as a follow-up behind it
		const fixture = await resumeFixture();
		fixtures.push(fixture);
		const ticket = openTicket(fixture, "result:batch");
		const toolStarted = fixture.toolStarted();
		const running = fixture.h.session.prompt("start");
		await toolStarted;
		const ended = deliveryEnded(fixture, ticket);
		const first = sendWithTicket(fixture, ticket);
		await ended;

		// When the producer re-sends the same batch while that message is still queued
		const again = sendWithTicket(fixture, ticket);
		fixture.releaseTool();
		await running;
		await settle(fixture);

		// Then both sends settle with the one entry that carried the queued message, and the ticket is settled
		const [firstReceipts, againReceipts] = await settlesWithin(Promise.all([first, again]), "itemized receipts");
		expect(againReceipts?.map((receipt) => receipt.disposition)).toEqual(["message_persisted", "message_persisted"]);
		expect(againReceipts?.map((receipt) => receipt.entryId)).toEqual(
			firstReceipts?.map((receipt) => receipt.entryId),
		);
		expect(ticketOpen(fixture, ticket)).toBe(false);
	});
});
