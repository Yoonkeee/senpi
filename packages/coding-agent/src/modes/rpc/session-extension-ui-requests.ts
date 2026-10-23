import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "./rpc-types.ts";

type PendingRequest = {
	resolve: (value: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
	frame?: RpcExtensionUIRequest;
};

export const sessionDialogRequests = new WeakMap<object, SessionExtensionUiRequests>();

/** Per-session extension UI request state; never share this map between bindings. */
export class SessionExtensionUiRequests {
	private readonly pending = new Map<string, PendingRequest>();
	private readonly changed: (() => void) | undefined;
	constructor(changed?: () => void) {
		this.changed = changed;
	}

	set(id: string, request: PendingRequest): void {
		this.pending.set(id, request);
		this.changed?.();
	}

	delete(id: string): void {
		this.pending.delete(id);
		this.changed?.();
	}

	snapshot(): RpcExtensionUIRequest[] {
		return [...this.pending.values()].flatMap((request) => (request.frame ? [request.frame] : []));
	}

	resolve(response: RpcExtensionUIResponse, beforeAnswer?: () => void): boolean {
		const request = this.pending.get(response.id);
		if (!request) return false;
		beforeAnswer?.();
		this.pending.delete(response.id);
		this.changed?.();
		request.resolve(response);
		return true;
	}

	cancelAll(): void {
		for (const [id, request] of this.pending) request.resolve({ type: "extension_ui_response", id, cancelled: true });
		this.pending.clear();
		this.changed?.();
	}

	close(): void {
		for (const request of this.pending.values()) {
			request.reject(new Error("Extension UI request cancelled: session closed"));
		}
		this.pending.clear();
		this.changed?.();
	}
}
