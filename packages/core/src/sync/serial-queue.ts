/**
 * Runs tasks one at a time in submission order. Every local state change of
 * the sync engine goes through one queue, so the pts bookkeeping in memory
 * and the rows in SQLite never interleave between two updates.
 */
export class SerialQueue {
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;

	run<T>(task: () => Promise<T>): Promise<T> {
		this.pending++;
		const result = this.tail.then(task);
		this.tail = result.then(
			() => {
				this.pending--;
			},
			() => {
				this.pending--;
			},
		);
		return result;
	}

	get busy(): boolean {
		return this.pending > 0;
	}
}
