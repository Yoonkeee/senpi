import type { LifecycleApi } from "../session-lifecycle-types.ts";

/** Like other extension actions, resolve the live session only when invoked. */
export function createLifecycleApi(resolve: () => LifecycleApi): LifecycleApi {
	return {
		get obligations() {
			return resolve().obligations;
		},
		reportChild(report) {
			resolve().reportChild(report);
		},
		markRunCompleted(run) {
			resolve().markRunCompleted(run);
		},
	};
}
