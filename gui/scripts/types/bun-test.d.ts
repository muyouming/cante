// Minimal ambient types for `bun:test`.
//
// gui/tsconfig.json sets `"types": []` and gui/package.json ships no
// `@types/bun`/`bun-types`, so `tsc --noEmit` cannot resolve `bun:test` in the
// ported `src/*.test.ts`. The frozen tsconfig and package.json are owned by the
// integrator, so the harness supplies this shim plus
// `scripts/tsconfig.typecheck.json` (which extends the frozen config) instead.
declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;

  interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toMatch(expected: string | RegExp): void;
    toMatchObject(expected: object): void;
    toContain(expected: unknown): void;
    toHaveLength(expected: number): void;
    toBeGreaterThan(expected: number | bigint): void;
    toBeGreaterThanOrEqual(expected: number | bigint): void;
    toBeLessThan(expected: number | bigint): void;
    toBeLessThanOrEqual(expected: number | bigint): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toThrow(expected?: unknown): void;
    not: Matchers;
    resolves: Matchers;
    rejects: Matchers;
    // Forward-compatible: new matchers in later `bun test` files still typecheck.
    [matcher: string]: any;
  }

  export function expect(actual: unknown): Matchers;
}
