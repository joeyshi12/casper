import type { TranscriptItem, TranscriptToolCall } from '@casper/shared';
import type { ChildSession } from './kiroFiles.js';

/** The stage shape read off a `subagent` tool call's rawInput: enough to expand the
 *  prompt text a child's title is drawn from. */
interface StageInput {
  name: string;
  prompt_template?: string;
}

/** The parts of a `subagent` tool call's rawInput this matcher needs. A call with no
 *  `stages[]` at all has no stage name to assign and is skipped by subagentCallsIn. */
interface SubagentCallInput {
  task?: string;
  stages: StageInput[];
}

function isStageInput(v: unknown): v is StageInput {
  return typeof v === 'object' && v !== null && typeof (v as StageInput).name === 'string';
}

function subagentCallInput(tool: TranscriptToolCall): SubagentCallInput | null {
  if (tool.name !== 'subagent') return null;
  const input = tool.input as { task?: unknown; stages?: unknown } | undefined;
  if (!input || !Array.isArray(input.stages)) return null;
  const stages = input.stages.filter(isStageInput);
  return { task: typeof input.task === 'string' ? input.task : undefined, stages };
}

/** kiro truncates a session's title to this many characters of the initial query. */
const TITLE_MAX_LENGTH = 150;

/** The text kiro would have titled a child session with, for one stage of one call:
 *  the stage's prompt_template with `{task}` substituted, truncated the same way kiro
 *  truncates a session title. */
function expectedTitle(call: SubagentCallInput, stage: StageInput): string {
  const task = call.task ?? '';
  const expanded = stage.prompt_template ? stage.prompt_template.replace('{task}', task) : task;
  return expanded.slice(0, TITLE_MAX_LENGTH);
}

export interface SubagentCall {
  toolCallId: string;
  /** Index of this tool call among all transcript items, for ordering matches between
   *  calls when titles alone don't disambiguate. */
  itemIndex: number;
  input: SubagentCallInput;
}

/** Every `subagent` tool call in a parent's transcript, in the order they appear. */
export function subagentCallsIn(transcript: TranscriptItem[]): SubagentCall[] {
  const calls: SubagentCall[] = [];
  transcript.forEach((item, itemIndex) => {
    if (item.type !== 'tool_call') return;
    const input = subagentCallInput(item.tool);
    if (!input) return;
    calls.push({ toolCallId: item.tool.id, itemIndex, input });
  });
  return calls;
}

export interface FallbackMatch {
  sessionId: string;
  toolCallId: string;
  stageName: string;
}

/**
 * Matches children with no recorded link against the stages of the `subagent` calls in
 * their parent's transcript, by title: a child's title is the start of the prompt its
 * stage was given. A child matching no stage is left out rather than guessed at.
 *
 * Children are claimed in creation order, earliest first, matched against calls in the
 * order they appear. Each call claims at most one child per declared stage.
 */
export function matchSubagentsFallback(calls: SubagentCall[], children: ChildSession[]): FallbackMatch[] {
  const sortedCalls = [...calls].sort((a, b) => a.itemIndex - b.itemIndex);
  const unclaimed = [...children].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const matches: FallbackMatch[] = [];

  for (const call of sortedCalls) {
    for (const stage of call.input.stages) {
      const want = expectedTitle(call.input, stage);
      if (!want) continue;
      const i = unclaimed.findIndex((c) => want.startsWith(c.title) || c.title.startsWith(want));
      if (i < 0) continue;
      const child = unclaimed.splice(i, 1)[0]!;
      matches.push({ sessionId: child.sessionId, toolCallId: call.toolCallId, stageName: stage.name });
    }
  }
  return matches;
}
