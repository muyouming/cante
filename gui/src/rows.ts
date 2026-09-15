// Transcript row model.
//
// Kept free of framework imports so the pure layout pass (`transcript.ts`) and
// its tests can run on plain Bun.

export type RowKind = "user" | "agent" | "thinking" | "tool" | "info" | "error" | "turn";
export type RowTone = "accent" | "neutral" | "ok" | "warn" | "error" | "muted";

export interface Row {
  /** Stable across updates; the layout cache keys on the object itself. */
  id: string;
  kind: RowKind;
  label: string;
  text: string;
  detail: string;
  tone: RowTone;
  streaming: boolean;
  time: string;
}
