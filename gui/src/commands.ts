// Command model: built-ins the GUI can run itself, plus session skills the
// daemon owns.
//
// PocketJS has no physical-keyboard text path yet (the system OSK is the only
// text entry), so a discoverable command surface is what keeps the client
// usable on a gamepad: everything here is reachable by d-pad, and a command
// that needs an argument prefills the composer instead of demanding typing.
//
// Pure module: no framework imports, so it unit-tests on Bun.
import type { SkillMetadata } from "./protocol.ts";

export type ClientAction =
  | "new-session"
  | "clear-view"
  | "compact"
  | "context"
  | "model"
  | "effort"
  | "permissions"
  | "interrupt"
  | "goal"
  | "goal-clear";

export interface Command {
  /** Without the leading slash. */
  name: string;
  title: string;
  hint: string;
  source: "builtin" | "skill";
  /** Handled inside the GUI. */
  client?: ClientAction;
  /** Selecting it prefills `/<name> ` in the composer and stops there. */
  prefill?: string;
}

const BUILTINS: readonly Command[] = [
  { name: "new", title: "New session", hint: "Restart the conversation with the current settings", source: "builtin", client: "new-session" },
  { name: "model", title: "Choose model…", hint: "Open the provider / model picker", source: "builtin", client: "model" },
  { name: "effort", title: "Cycle effort", hint: "Next reasoning effort level", source: "builtin", client: "effort" },
  { name: "permissions", title: "Cycle permissions", hint: "Strict → Auto → Yolo", source: "builtin", client: "permissions" },
  { name: "goal", title: "Set a goal", hint: "Keep working until a condition holds", source: "builtin", client: "goal", prefill: "<condition>" },
  { name: "goal-clear", title: "Clear the goal", hint: "Stop the goal loop", source: "builtin", client: "goal-clear" },
  { name: "compact", title: "Compact history", hint: "Replace the history with a summary", source: "builtin", client: "compact" },
  { name: "context", title: "Context report", hint: "Per-category context occupancy", source: "builtin", client: "context" },
  { name: "interrupt", title: "Interrupt turn", hint: "Stop the running turn", source: "builtin", client: "interrupt" },
  { name: "clear", title: "Clear the view", hint: "Discard the transcript on screen (session keeps running)", source: "builtin", client: "clear-view" },
];

export function builtinCommands(): readonly Command[] {
  return BUILTINS;
}

/** A built-in by exact name, or undefined (so the daemon can own it). */
export function builtinCommand(name: string): Command | undefined {
  return BUILTINS.find((command) => command.name === name);
}

/** Session skills, which the daemon runs as `SlashCommand`s. */
export function skillCommands(skills: readonly SkillMetadata[]): Command[] {
  return skills.map((skill) => ({
    name: skill.name,
    title: `/${skill.name}`,
    hint: skill.description ?? "session skill",
    source: "skill" as const,
    ...(skill.argument_hint ? { prefill: skill.argument_hint } : {}),
  }));
}

export function allCommands(skills: readonly SkillMetadata[]): Command[] {
  return [...BUILTINS, ...skillCommands(skills)];
}

/** Split `/name rest of it` into its parts; null when it is not a command. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  if (!body) return null;
  const match = /\s/.exec(body);
  if (!match) return { name: body, args: "" };
  const at = match.index;
  return { name: body.slice(0, at), args: body.slice(at + 1).trim() };
}

/** Filter for the palette: prefix matches first, then substring matches. */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...commands];
  const prefix: Command[] = [];
  const rest: Command[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) prefix.push(command);
    else if (name.includes(needle) || command.hint.toLowerCase().includes(needle)) rest.push(command);
  }
  return [...prefix, ...rest];
}
