// The AI's task list, as its latest revision says.
import { TodoState, type TodoItem } from "@achoo254/chat-proto/remote/remote";
import { useMachinesCopy } from "../use-machines-copy.ts";

export function TodoCard({ todo }: { todo: TodoItem }) {
	const t = useMachinesCopy();
	return (
		<div className="mx-todo" role="group" aria-label={t.transcript.todo}>
			{todo.entries.map((entry, i) => {
				const state = entry.state === TodoState.DONE ? "done" : entry.state === TodoState.IN_PROGRESS ? "now" : "";
				return (
					<div key={i} className={`t ${state}`}>
						<span className="box" aria-hidden="true">
							{state === "done" ? "✓" : ""}
						</span>
						<span>{entry.text}</span>
					</div>
				);
			})}
		</div>
	);
}
