declare namespace JSX {
  interface Element {}
  interface IntrinsicElements {
    [name: string]: Record<string, unknown>;
  }
}

declare module "react" {
  export interface ReactNode {}
  export interface ReactElement {}
  export type Children = ReactNode;
  export function createContext<T>(value: T): { Provider: (props: { value: T; children?: ReactNode }) => ReactElement; Consumer: (props: { children: (value: T) => ReactNode }) => ReactElement };
  export function useContext<T>(context: { Provider: unknown }): T;
  export function use<T>(context: { Provider: unknown }): T;
  export function memo<T>(component: T): T;
  export function forwardRef<T>(render: T): T;
  export function lazy<T>(factory: () => Promise<{ default: T }>): T;
  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): ReactElement;
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

declare module "react-dom/client" {
  export function createRoot(element: unknown): { render(node: unknown): void };
}
