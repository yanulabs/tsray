/**
 * Small glob matcher used for entrypoint, test, and exclusion patterns.
 * Supports `*`, `**`, `?`, and simple `{a,b}` alternation without pulling in a
 * dependency.
 */
export function globToRegExp(pattern: string): RegExp {
  const source = pattern.replace(/\\/g, "/");
  let out = "^";
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (char === "*") {
      if (source[i + 1] === "*") {
        const next = source[i + 2];
        if (next === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (char === "{") {
      const end = source.indexOf("}", i + 1);
      if (end > i) {
        const options = source
          .slice(i + 1, end)
          .split(",")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        out += `(?:${options.join("|")})`;
        i = end + 1;
        continue;
      }
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

export function matchesAny(patterns: readonly string[], value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

export const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.svelte-kit/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/bin/**",
] as const;

/**
 * Framework entrypoints that would otherwise be reported as dead because no
 * indexed file explicitly references them.
 */
export const DEFAULT_ENTRYPOINTS = [
  "src/main.{ts,tsx,js,jsx}",
  "src/index.{ts,tsx,js,jsx}",
  "src/entry-client.{ts,tsx,js,jsx}",
  "src/entry-server.{ts,tsx,js,jsx}",
  "src/App.{ts,tsx,js,jsx}",
  "src/app/**/{page,layout,loading,error,not-found,global-error,template,default,route,middleware}.{ts,tsx,js,jsx}",
  "app/**/{page,layout,loading,error,not-found,global-error,template,default,route,middleware}.{ts,tsx,js,jsx}",
  "pages/**/*.{ts,tsx,js,jsx}",
  "src/pages/**/*.{ts,tsx,js,jsx}",
  "src/routes/**/*.{ts,tsx,js,jsx}",
  "app/routes/**/*.{ts,tsx,js,jsx}",
  "routes/**/*.{ts,tsx,js,jsx}",
  "**/*.stories.{ts,tsx,js,jsx,mdx}",
  "**/*.config.{ts,mts,cts,js,mjs,cjs}",
  "**/vite.config.{ts,js,mjs}",
  "**/vitest.config.{ts,js,mjs}",
  "**/playwright.config.{ts,js,mjs}",
  "scripts/**/*.{ts,mts,cts,js,mjs,cjs}",
  "src/**/__root.{ts,tsx,js,jsx}",
] as const;

export const TEST_FILE_RE = /(\.(test|spec|stories)\.[cm]?[jt]sx?$|\/__(tests|mocks)__\/|(^|\/)(test|tests)\/)/;

export const SOURCE_FILE_RE = /\.[cm]?[jt]sx?$/;
