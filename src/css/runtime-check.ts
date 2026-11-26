export interface RuntimeViewport {
  name: string;
  width: number;
  height: number;
}

export interface RuntimeCheckIssue {
  viewport: string;
  type: string;
  selector: string;
  details: string;
}

export interface RuntimeCheckResult {
  ok: boolean;
  issue_count: number;
  issues: RuntimeCheckIssue[];
  error?: string;
}

interface RuntimePage {
  goto(
    url: string,
    options: { waitUntil: "load" | "domcontentloaded" | "networkidle"; timeout: number }
  ): Promise<unknown>;
  evaluate<TArgument, TResult>(
    pageFunction: (argument: TArgument) => TResult,
    argument: TArgument
  ): Promise<TResult>;
  close(): Promise<void>;
}

interface RuntimeContext {
  newPage(): Promise<RuntimePage>;
  close(): Promise<void>;
}

interface RuntimeBrowser {
  newContext(options: { viewport: { width: number; height: number } }): Promise<RuntimeContext>;
  close(): Promise<void>;
}

interface PlaywrightModule {
  chromium: {
    launch(options: { headless: boolean }): Promise<RuntimeBrowser>;
  };
}

const DEFAULT_VIEWPORTS: RuntimeViewport[] = [
  { name: "mobile", width: 375, height: 812 },
  { name: "desktop", width: 1440, height: 900 },
];

/**
 * Optional Playwright pass. Static CSS analysis cannot see Tailwind, CSS-in-JS,
 * or runtime state; this checks the rendered page instead. Playwright stays an
 * optional peer dependency and is loaded lazily.
 */
export async function runRuntimeCheck(
  url: string,
  viewports: RuntimeViewport[] = DEFAULT_VIEWPORTS
): Promise<RuntimeCheckResult> {
  const moduleName = "playwright";
  let playwright: PlaywrightModule;
  try {
    playwright = (await import(moduleName)) as PlaywrightModule;
  } catch {
    return {
      ok: false,
      issue_count: 0,
      issues: [],
      error:
        "Playwright is not installed. Install it with 'npm i -D playwright' to enable runtime layout checks.",
    };
  }

  let browser: RuntimeBrowser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (error) {
    return {
      ok: false,
      issue_count: 0,
      issues: [],
      error: `Playwright could not launch Chromium: ${
        error instanceof Error ? error.message : String(error)
      }. Install browsers with 'npx playwright install chromium'.`,
    };
  }
  const issues: RuntimeCheckIssue[] = [];

  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      let page: RuntimePage | null = null;
      try {
        page = await context.newPage();
        await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

        const found = await page.evaluate((viewportName: string) => {
          type AnyElement = any;
          type AnyStyle = any;

          const result: Array<Record<string, string>> = [];
          const seen = new Set<string>();
          const browserGlobal = globalThis as any;
          const document = browserGlobal.document;
          if (!document) return result;
          const view = document.defaultView;

          const push = (
            type: string,
            selector: string,
            details: string
          ): void => {
            const key = `${type}|${selector}`;
            if (seen.has(key) || result.length >= 200) return;
            seen.add(key);
            result.push({ viewport: viewportName, type, selector, details });
          };

          const selectorFor = (element: AnyElement): string => {
            if (element.id) return `#${element.id}`;
            const classes = Array.from(element.classList ?? []).slice(0, 3).join(".");
            return classes
              ? `${element.tagName.toLowerCase()}.${classes}`
              : element.tagName.toLowerCase();
          };

          const isHiddenUtility = (element: AnyElement): boolean =>
            /(^|[\s:])(sr-only|visually-hidden|visuallyhidden|screen-reader-only|screen-reader-text|invisible)(\s|$)/i.test(
              String(element.className ?? "")
            );

          const isVisuallyHidden = (rect: AnyElement, style: AnyStyle): boolean => {
            if (rect.width <= 1 && rect.height <= 1 && /hidden|clip/.test(style.overflow)) {
              return true;
            }
            if (style.clip === "rect(0px, 0px, 0px, 0px)") return true;
            if (style.clipPath === "inset(50%)") return true;
            if (
              style.position === "absolute" &&
              (Number.parseFloat(style.left) <= -999 ||
                Number.parseFloat(style.top) <= -999)
            ) {
              return true;
            }
            return false;
          };

          const ignoredTags = new Set([
            "SCRIPT",
            "STYLE",
            "NOSCRIPT",
            "TEMPLATE",
            "BR",
            "WBR",
            "IMG",
            "VIDEO",
            "CANVAS",
            "IFRAME",
          ]);

          const documentElement = document.documentElement;
          if (documentElement.scrollWidth > view.innerWidth + 1) {
            push(
              "DOCUMENT_HORIZONTAL_OVERFLOW",
              "html",
              `scrollWidth (${documentElement.scrollWidth}px) exceeds viewport (${view.innerWidth}px).`
            );
          }

          for (const element of Array.from(
            document.querySelectorAll("body *")
          ) as AnyElement[]) {
            if (
              !(element instanceof view.HTMLElement) ||
              element instanceof view.SVGElement ||
              element.closest?.("svg") ||
              ignoredTags.has(element.tagName)
            ) {
              continue;
            }

            if (element.hidden || element.getAttribute("aria-hidden") === "true") continue;

            const style = view.getComputedStyle(element);
            if (
              style.display === "none" ||
              style.display === "contents" ||
              style.visibility === "hidden" ||
              style.visibility === "collapse" ||
              style.opacity === "0" ||
              style.contentVisibility === "hidden" ||
              style.pointerEvents === "none"
            ) {
              continue;
            }
            if (
              element.offsetParent === null &&
              style.position !== "fixed" &&
              style.position !== "sticky"
            ) {
              continue;
            }

            const rect = element.getBoundingClientRect();
            if (isHiddenUtility(element) || isVisuallyHidden(rect, style)) continue;

            const selector = selectorFor(element);

            if (
              style.display !== "inline" &&
              element.clientWidth > 0 &&
              element.scrollWidth > element.clientWidth + 2 &&
              style.overflowX === "visible" &&
              style.textOverflow !== "ellipsis"
            ) {
              push(
                "ELEMENT_HORIZONTAL_OVERFLOW",
                selector,
                `Content width (${element.scrollWidth}px) overflows container (${element.clientWidth}px) with overflow-x: ${style.overflowX}.`
              );
            }

            if (
              element.childElementCount === 0 &&
              String(element.textContent ?? "").trim().length > 0 &&
              element.clientHeight > 0 &&
              element.scrollHeight > element.clientHeight + 3 &&
              style.overflowY === "hidden" &&
              style.webkitLineClamp === "none"
            ) {
              push(
                "CLIPPED_TEXT",
                selector,
                `Vertical clipping detected: scrollHeight (${element.scrollHeight}px) > clientHeight (${element.clientHeight}px).`
              );
            }

            const role = element.getAttribute("role");
            const interactive =
              ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(
                element.tagName
              ) ||
              (role !== null &&
                ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem"].includes(
                  role
                ));
            if (!interactive || element.disabled) continue;

            if (rect.width === 0 || rect.height === 0) {
              push(
                "COLLAPSED_INTERACTIVE_ELEMENT",
                selector,
                `Visible interactive control collapsed to ${Math.round(rect.width)}x${Math.round(rect.height)}px.`
              );
              continue;
            }

            if (
              rect.top >= 0 &&
              rect.left >= 0 &&
              rect.bottom <= view.innerHeight &&
              rect.right <= view.innerWidth
            ) {
              const centerX = rect.left + rect.width / 2;
              const centerY = rect.top + rect.height / 2;
              const topElement = document.elementFromPoint(centerX, centerY);
              if (
                topElement &&
                !element.contains(topElement) &&
                !topElement.contains(element)
              ) {
                push(
                  "OBSCURED_INTERACTIVE_ELEMENT",
                  selector,
                  `Control center (${Math.round(centerX)},${Math.round(centerY)}) is covered by '${selectorFor(topElement)}'.`
                );
              }
            }
          }

          return result;
        }, viewport.name);

        for (const issue of found) {
          issues.push({
            viewport: issue.viewport ?? viewport.name,
            type: issue.type ?? "UNKNOWN",
            selector: issue.selector ?? "",
            details: issue.details ?? "",
          });
        }
      } catch (error) {
        issues.push({
          viewport: viewport.name,
          type: "VIEWPORT_CHECK_FAILED",
          selector: "body",
          details: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (page) await page.close().catch(() => undefined);
        await context.close().catch(() => undefined);
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  return {
    ok: issues.length === 0,
    issue_count: issues.length,
    issues,
  };
}
