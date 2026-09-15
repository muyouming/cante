// TEMPORARY type shim (workstream B).
//
// `tsconfig.json` sets `"types": []` and the package has no `bun-types` /
// `@types/bun` devDependency, so `bunx tsc --noEmit` cannot resolve the
// `bun:test` module imported by the (fixed, workstream-owned) test files.
//
// Integrator: add `bun-types` (or `@types/bun`) to `devDependencies` and delete
// this file. It declares only ambient function/type shapes, so it merges
// harmlessly with the real package if both are present.
declare module "bun:test" {
  export function describe(label: string, fn: () => void): void;
  export function test(label: string, fn: () => void | Promise<void>): void;
  export function it(label: string, fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function expect(value: unknown): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const mock: any;
}
