export type Selection = { type: "symbol"; id: string } | { type: "module"; id: string } | null;

export type Theme = "light" | "dark";

export type LiveStatus = "live" | "static" | "refreshing" | "offline";
