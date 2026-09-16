// What this session is equipped with: MCP servers, skills, and subagents.
//
// This is the desktop answer to Claude Desktop's Connectors / Customize
// surface. `ExtensionRefreshed` arrives with the session (the store folds it
// into `store.capabilities()`), so the panel has real content from the first
// paint — no "loading" state is needed. Each group states its own emptiness
// explicitly rather than rendering nothing, so "no skills" is distinguishable
// from "the panel failed to load".
//
// The store member is read through a local typed view with every field
// optional: the panel must keep rendering (and must not throw) even before the
// store workstream lands `capabilities()`, and the public prop stays exactly
// `{ store: Store }`.
import { For, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";

import type { Store } from "../store.ts";

export interface CapabilityMcpServer {
  name: string;
  tools: number;
}

export interface CapabilityItem {
  name: string;
  description: string;
}

export interface Capabilities {
  mcpServers: CapabilityMcpServer[];
  skills: CapabilityItem[];
  subagents: CapabilityItem[];
}

export interface CapabilitiesPanelProps {
  store: Store;
}

const EMPTY: Capabilities = { mcpServers: [], skills: [], subagents: [] };

type CapabilitiesStore = Store & { capabilities?: Accessor<Capabilities> };

/** "1 tool" / "3 tools", tolerant of a hostile count. */
export function toolCountLabel(count: number): string {
  const value = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return `${value} ${value === 1 ? "tool" : "tools"}`;
}

/** Defensive read: a missing/partial payload renders as three empty groups. */
export function readCapabilities(value: Capabilities | undefined | null): Capabilities {
  if (!value) return EMPTY;
  return {
    mcpServers: Array.isArray(value.mcpServers) ? value.mcpServers : [],
    skills: Array.isArray(value.skills) ? value.skills : [],
    subagents: Array.isArray(value.subagents) ? value.subagents : [],
  };
}

function Group(props: { label: string; count: number; empty: string; children: JSX.Element }): JSX.Element {
  return (
    <div class="flex flex-col gap-1">
      <span class="text-[10px] tracking-widest text-slate-600">
        {props.label} ({props.count})
      </span>
      <Show when={props.count > 0} fallback={<span class="text-xs text-slate-600">{props.empty}</span>}>
        {props.children}
      </Show>
    </div>
  );
}

function Description(props: { text: string }): JSX.Element {
  return (
    <Show when={props.text.trim()}>
      <span class="break-words text-[10px] leading-4 text-slate-500">{props.text}</span>
    </Show>
  );
}

export default function CapabilitiesPanel(props: CapabilitiesPanelProps): JSX.Element {
  const store = props.store as CapabilitiesStore;
  const capabilities = (): Capabilities => readCapabilities(store.capabilities?.());

  return (
    <section class="flex flex-col gap-3" aria-label="Session capabilities">
      <span class="text-[10px] font-bold tracking-widest text-slate-500">CAPABILITIES</span>

      <Group
        label="MCP SERVERS"
        count={capabilities().mcpServers.length}
        empty="no MCP servers in this session"
      >
        <ul class="flex flex-col gap-1" role="list">
          <For each={capabilities().mcpServers}>
            {(server) => (
              <li class="flex items-baseline justify-between gap-2">
                <span class="truncate text-xs text-slate-300" title={server.name}>
                  {server.name}
                </span>
                <span class="shrink-0 text-[10px] text-slate-500">{toolCountLabel(server.tools)}</span>
              </li>
            )}
          </For>
        </ul>
      </Group>

      <Group label="SKILLS" count={capabilities().skills.length} empty="no skills in this session">
        <ul class="flex flex-col gap-1.5" role="list">
          <For each={capabilities().skills}>
            {(skill) => (
              <li class="flex flex-col">
                <span class="truncate text-xs text-slate-300" title={skill.name}>
                  {skill.name}
                </span>
                <Description text={skill.description} />
              </li>
            )}
          </For>
        </ul>
      </Group>

      <Group label="SUBAGENTS" count={capabilities().subagents.length} empty="no subagents in this session">
        <ul class="flex flex-col gap-1.5" role="list">
          <For each={capabilities().subagents}>
            {(agent) => (
              <li class="flex flex-col">
                <span class="truncate text-xs text-slate-300" title={agent.name}>
                  {agent.name}
                </span>
                <Description text={agent.description} />
              </li>
            )}
          </For>
        </ul>
      </Group>
    </section>
  );
}
