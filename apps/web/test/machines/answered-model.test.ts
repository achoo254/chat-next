// Which model the AI's default is: the latest turn that says which model
// answered, shown the way people name the models.
import { create } from "@bufbuild/protobuf";
import { ItemSchema, TurnState } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { answeredModel } from "../../src/machines/transcript/tool-fold.ts";
import { readableModel } from "../../src/machines/use-machines.ts";

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
});
