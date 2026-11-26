declare namespace JSX {
  interface Element {}
  interface IntrinsicElements {
    [name: string]: Record<string, unknown>;
  }
}

declare module "react/jsx-runtime" {
  export namespace JSX {
    interface Element {}
    interface IntrinsicElements {
      [name: string]: Record<string, unknown>;
    }
  }
  export function jsx(type: unknown, props: unknown, key?: unknown): JSX.Element;
  export function jsxs(type: unknown, props: unknown, key?: unknown): JSX.Element;
  export const Fragment: unknown;
}
