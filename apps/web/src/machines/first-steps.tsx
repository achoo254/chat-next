// The AI Agent column for an account that has not gone the whole way yet:
// connect a machine, add a project, open a first session. The steps are read
// from what the account already has (nothing is stored); the first one still
// open is the current step, with what it needs and its button, the later
// ones wait greyed with the reason. Once all three are done the column shows
// the project tree alone.
import type { ReactNode } from "react";
import { Icon } from "../components/screen-icons.tsx";
import { Link, paths } from "../router.tsx";
import { CLI_GUIDE, detectOs } from "./add-machine.tsx";
import { useMachinesCopy } from "./use-machines-copy.ts";

export interface FirstStepsProgress {
	machines: number;
	projects: number;
	sessions: number;
}

type StepId = "machine" | "project" | "session";

/** Whether the account still has a step to go (the column then shows the steps). */
export const stepsPending = (p: FirstStepsProgress): boolean => p.machines === 0 || p.projects === 0 || p.sessions === 0;

export function FirstSteps({ progress, addProject }: { progress: FirstStepsProgress; addProject: ReactNode }) {
	const t = useMachinesCopy();
	const copy = t.agent.steps;
	const welcome = t.agent.welcome;
	const phone = detectOs(navigator.userAgent) === "phone";
	const done: Record<StepId, boolean> = { machine: progress.machines > 0, project: progress.projects > 0, session: progress.sessions > 0 };
	const order: StepId[] = ["machine", "project", "session"];
	const current = order.find((id) => !done[id]);
	return (
		<section className="mx-steps" data-id="first-steps" aria-labelledby="mx-steps-title">
			<h3 id="mx-steps-title">{copy.title}</h3>
			<ol>
				{order.map((id, index) => {
					const state = done[id] ? "done" : id === current ? "current" : "todo";
					const step = copy[id];
					return (
						<li key={id} data-step={id} data-state={state} aria-current={state === "current" ? "step" : undefined}>
							<span className="mx-step-mark" aria-hidden="true">
								{state === "done" ? <Icon name="check" small /> : index + 1}
							</span>
							<div className="mx-step-body">
								<b>{step.title}</b>
								{state === "done" && <span className="sr-only">{copy.done}</span>}
								{state === "current" && <p>{step.body}</p>}
								{state === "todo" && id !== "machine" && <p className="mx-step-locked">{copy[id].locked}</p>}
								{state === "current" && id === "machine" && (
									<>
										<p className="note">
											{welcome.needs}{" "}
											<a href={CLI_GUIDE} target="_blank" rel="noreferrer">
												{welcome.guide}
											</a>
										</p>
										{phone && <p className="note">{welcome.onPhone}</p>}
										<Link to={paths.machinesAdd()} className="btn btn-primary btn-sm" data-id="first-machine-add">
											<Icon name="plus" small />
											{welcome.start}
										</Link>
									</>
								)}
								{state === "current" && id === "project" && addProject}
							</div>
						</li>
					);
				})}
			</ol>
		</section>
	);
}
