import { createContext, useContext } from "react";
import type { ReactNode } from "react";

export interface Theme {
  name: string;
}

export const ThemeContext = createContext<Theme>({ name: "light" });

export function ThemeProvider({ children }: { children?: ReactNode }) {
  return <ThemeContext.Provider value={{ name: "dark" }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
