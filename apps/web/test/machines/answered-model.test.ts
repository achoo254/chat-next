// Which model the AI's default is: the latest turn that says which model
// answered, shown the way people name the models.
import { create } from "@bufbuild/protobuf";
import { ItemSchema, TurnState } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { answeredModel } from "../../src/machines/transcript/tool-fold.ts";
import { defaultModelName, readableModel } from "../../src/machines/use-machines.ts";
import { MachineInfoSchema } from "@achoo254/chat-proto/remote/remote";

const turn = (model: string) => create(ItemSchema, { id: model || "t", body: { case: "turn", value: { state: TurnState.COMPLETED, model } } });

describe("the default model", () => {
	it("is the latest turn's answering model; a turn that does not say is skipped", () => {
		expect(answeredModel([turn("claude-sonnet-4-5"), turn("claude-opus-5-5"), turn("")])).toBe("claude-opus-5-5");
		expect(answeredModel([])).toBe("");
	});

	it("reads as people name it; another id stays as it is", () => {
		expect(readableModel("claude-opus-5-5")).toBe("Opus 5.5");
		expect(readableModel("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
		expect(readableModel("claude-haiku-5")).toBe("Haiku 5");
		expect(readableModel("claude-opus-5-5[1m]")).toBe("Opus 5.5");
		expect(readableModel("gpt-5")).toBe("gpt-5");
	});

	it("is the latest answer's model, else the one the machine's settings pick, else unknown", () => {
		const info = create(MachineInfoSchema, { providers: [{ id: "claude", defaultModel: "opus", capabilities: { models: [{ id: "opus", name: "Opus" }] } }] });
		expect(defaultModelName(info, "claude", "claude-opus-5-5")).toBe("Opus 5.5");
		expect(defaultModelName(info, "claude", "")).toBe("Opus");
		expect(defaultModelName(create(MachineInfoSchema, { providers: [{ id: "claude" }] }), "claude", "")).toBe("");
		expect(defaultModelName(null, "claude", "")).toBe("");
	});
});
