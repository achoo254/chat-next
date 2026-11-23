// The bottleneck rules, in the order the runner runs them.
import { apiSlowOrLimited } from "./api-slow-or-limited.ts";
import { contextHigh } from "./context-high.ts";
import { costSpike } from "./cost-spike.ts";
import { mcpErrors } from "./mcp-errors.ts";
import { repeatRead } from "./repeat-read.ts";
import type { Rule } from "./rule-types.ts";
import { subagentIdle } from "./subagent-idle.ts";
import { toolSlow } from "./tool-slow.ts";

export const ALL_RULES: readonly Rule[] = [toolSlow, apiSlowOrLimited, repeatRead, contextHigh, mcpErrors, subagentIdle, costSpike];
