// Unit tests for the command model.
//
//   bun test examples/gui/src
import { describe, expect, test } from "bun:test";

import { allCommands, builtinCommand, filterCommands, parseSlash, skillCommands } from "./commands.ts";

describe("parseSlash", () => {
  test("splits a command from its arguments", () => {
    expect(parseSlash("/compact")).toEqual({ name: "compact", args: "" });
    expect(parseSlash("  /goal  ship the parser  ")).toEqual({ name: "goal", args: "ship the parser" });
  });

  test("rejects non-commands and a bare slash", () => {
    expect(parseSlash("hello")).toBeNull();
    expect(parseSlash("/")).toBeNull();
    expect(parseSlash("   ")).toBeNull();
  });

  test("keeps the rest of the line intact for multi-word arguments", () => {
    expect(parseSlash("/shell rg -n 'upload' src/")?.args).toBe("rg -n 'upload' src/");
  });
});

describe("built-ins", () => {
  test("every built-in that needs an argument prefills the composer", () => {
    expect(builtinCommand("goal")?.prefill).toBeTruthy();
    expect(builtinCommand("compact")?.prefill).toBeUndefined();
  });

  test("names are unique and slash-free", () => {
    for (const command of allCommands([])) {
      expect(command.name).not.toContain("/");
      expect(command.name).not.toContain(" ");
    }
    const names = allCommands([]).map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("local intents stay local", () => {
    expect(builtinCommand("new")?.client).toBe("new-session");
    expect(builtinCommand("clear")?.client).toBe("clear-view");
    expect(builtinCommand("rename")).toBeUndefined();
  });
});

describe("skills", () => {
  test("become slash commands, prefilling when the skill hints an argument", () => {
    const commands = skillCommands([
      { name: "simplify", description: "Simplify the current diff" },
      { name: "add-provider", description: "Add a provider", argument_hint: "<provider>" },
    ]);
    expect(commands.map((command) => command.name)).toEqual(["simplify", "add-provider"]);
    expect(commands[0]!.client).toBeUndefined();
    expect(commands[0]!.prefill).toBeUndefined();
    expect(commands[1]!.prefill).toBe("<provider>");
  });

  test("are appended after the built-ins", () => {
    const commands = allCommands([{ name: "simplify", description: "" }]);
    expect(commands[commands.length - 1]!.name).toBe("simplify");
    expect(commands[0]!.source).toBe("builtin");
  });
});

describe("filterCommands", () => {
  test("prefers prefix matches over substring matches", () => {
    const commands = skillCommands([
      { name: "clear-cache", description: "drop caches" },
      { name: "cache", description: "warm caches" },
    ]);
    const filtered = filterCommands(commands, "cache");
    expect(filtered.map((command) => command.name)).toEqual(["cache", "clear-cache"]);
  });

  test("matches hints too, and an empty query returns everything", () => {
    const commands = skillCommands([{ name: "simplify", description: "Simplify the diff" }]);
    expect(filterCommands(commands, "diff").map((command) => command.name)).toEqual(["simplify"]);
    expect(filterCommands(commands, "  ")).toHaveLength(1);
  });
});
