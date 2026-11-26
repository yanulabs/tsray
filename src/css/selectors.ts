import * as csstree from "css-tree";
import type { CssNode, Selector, SelectorList } from "css-tree";
import type { CssClassBinding, CssSpecificity } from "./types.js";

const ZERO: CssSpecificity = { id: 0, class: 0, type: 0 };

export function compareSpecificity(a: CssSpecificity, b: CssSpecificity): number {
  if (a.id !== b.id) return a.id - b.id;
  if (a.class !== b.class) return a.class - b.class;
  return a.type - b.type;
}

export function addSpecificity(a: CssSpecificity, b: CssSpecificity): CssSpecificity {
  return { id: a.id + b.id, class: a.class + b.class, type: a.type + b.type };
}

function maxSpecificity(a: CssSpecificity, b: CssSpecificity): CssSpecificity {
  return compareSpecificity(a, b) >= 0 ? a : b;
}

function childrenOf(node: CssNode): CssNode[] {
  if (
    node.type === "SelectorList" ||
    node.type === "Selector" ||
    node.type === "PseudoClassSelector" ||
    node.type === "PseudoElementSelector"
  ) {
    return node.children ? node.children.toArray() : [];
  }
  if (node.type === "Nth" && node.selector) {
    return [node.selector];
  }
  return [];
}

/** Parse a CSS Modules `:global(...)` / `:local(...)` argument as a selector list. */
function parsePseudoArgument(node: {
  type: "PseudoClassSelector" | "PseudoElementSelector";
  children: csstree.List<CssNode> | null;
}): SelectorList | null {
  if (!node.children || node.children.isEmpty) return null;
  const first = node.children.first;
  if (!first) return null;
  const text =
    first.type === "Raw"
      ? first.value
      : node.children.toArray().map((child) => csstree.generate(child)).join("");
  try {
    return csstree.parse(text, { context: "selectorList" }) as SelectorList;
  } catch {
    return null;
  }
}

export function specificityOfSelector(selector: Selector): CssSpecificity {
  return specificityOfNodes(selector.children.toArray());
}

function specificityOfSelectorList(list: SelectorList): CssSpecificity {
  let best = ZERO;
  for (const selector of list.children) {
    if (selector.type !== "Selector") continue;
    best = maxSpecificity(best, specificityOfSelector(selector));
  }
  return best;
}

function specificityOfNodes(nodes: readonly CssNode[]): CssSpecificity {
  let result = { ...ZERO };

  for (const node of nodes) {
    switch (node.type) {
      case "IdSelector":
        result = addSpecificity(result, { id: 1, class: 0, type: 0 });
        break;
      case "ClassSelector":
      case "AttributeSelector":
        result = addSpecificity(result, { id: 0, class: 1, type: 0 });
        break;
      case "TypeSelector":
        if (node.name !== "*" && !node.name.endsWith("|*")) {
          result = addSpecificity(result, { id: 0, class: 0, type: 1 });
        }
        break;
      case "PseudoElementSelector": {
        result = addSpecificity(result, { id: 0, class: 0, type: 1 });
        const argument = parsePseudoArgument(node);
        if (argument) result = addSpecificity(result, specificityOfSelectorList(argument));
        break;
      }
      case "PseudoClassSelector": {
        const name = node.name.toLowerCase();
        if (name === "where") break;
        if (name === "is" || name === "not" || name === "has" || name === "matches") {
          const argument = parsePseudoArgument(node);
          if (argument) result = addSpecificity(result, specificityOfSelectorList(argument));
          break;
        }
        if (name === "nth-child" || name === "nth-last-child") {
          result = addSpecificity(result, { id: 0, class: 1, type: 0 });
          const nth = node.children
            ? node.children.toArray().find((child) => child.type === "Nth")
            : undefined;
          if (nth?.type === "Nth" && nth.selector) {
            result = addSpecificity(result, specificityOfSelectorList(nth.selector));
          }
          break;
        }
        if (name === "host" || name === "host-context") {
          result = addSpecificity(result, { id: 0, class: 1, type: 0 });
          const argument = parsePseudoArgument(node);
          if (argument) result = addSpecificity(result, specificityOfSelectorList(argument));
          break;
        }
        if (name === "global" || name === "local") {
          // CSS Modules pseudo-classes disappear during compilation. Their
          // arguments are real selectors and therefore contribute specificity.
          const argument = parsePseudoArgument(node);
          if (argument) result = addSpecificity(result, specificityOfSelectorList(argument));
          break;
        }
        result = addSpecificity(result, { id: 0, class: 1, type: 0 });
        break;
      }
      case "NestingSelector":
        // A nesting selector is replaced with the parent selector list before
        // specificity is computed. A bare `&` contributes nothing itself.
        break;
      default:
        break;
    }
  }

  return result;
}

export function specificityOfSelectorText(text: string): CssSpecificity {
  try {
    const selector = csstree.parse(text, { context: "selector" }) as Selector;
    return specificityOfSelector(selector);
  } catch {
    return { ...ZERO };
  }
}

function visitSelectors(
  node: CssNode,
  global: boolean,
  inModule: boolean,
  out: CssClassBinding[]
): void {
  if (node.type === "ClassSelector") {
    out.push({ name: csstree.ident.decode(node.name), isGlobal: !inModule || global });
    return;
  }

  if (node.type === "SelectorList") {
    visitSelectorList(node, inModule, out, global);
    return;
  }

  if (node.type === "Selector") {
    visitSelector(node, inModule, out, global);
    return;
  }

  if (node.type === "PseudoClassSelector") {
    const name = node.name.toLowerCase();
    if (name === "global") {
      const argument = parsePseudoArgument(node);
      if (argument) {
        for (const selector of argument.children) {
          if (selector.type === "Selector") visitSelector(selector, inModule, out, true);
        }
      }
      return;
    }
    if (name === "local") {
      const argument = parsePseudoArgument(node);
      if (argument) {
        for (const selector of argument.children) {
          if (selector.type === "Selector") visitSelector(selector, inModule, out, false);
        }
      }
      return;
    }
  }

  for (const child of childrenOf(node)) {
    visitSelectors(child, global, inModule, out);
  }
}

function visitSelector(
  selector: Selector,
  inModule: boolean,
  out: CssClassBinding[],
  initialGlobal = false
): void {
  let mode = initialGlobal;
  for (const node of selector.children) {
    if (node.type === "PseudoClassSelector") {
      const name = node.name.toLowerCase();
      if (name === "global" && !node.children) {
        mode = true;
        continue;
      }
      if (name === "local" && !node.children) {
        mode = false;
        continue;
      }
    }
    visitSelectors(node, mode, inModule, out);
  }
}

function visitSelectorList(
  list: SelectorList,
  inModule: boolean,
  out: CssClassBinding[],
  initialGlobal = false
): void {
  for (const selector of list.children) {
    if (selector.type === "Selector") visitSelector(selector, inModule, out, initialGlobal);
  }
}

/**
 * Extracts class names from a selector, honoring CSS Modules `:global()` and
 * `:local()` contexts. In plain CSS every class is global.
 */
export function extractClasses(selector: Selector, inModule: boolean): CssClassBinding[] {
  const out: CssClassBinding[] = [];
  const list = csstree.parse(csstree.generate(selector), {
    context: "selectorList",
  }) as SelectorList;
  visitSelectorList(list, inModule, out);

  // Deduplicate repeated class names while preserving selector order.
  const seen = new Set<string>();
  return out.filter((entry) => {
    const key = `${entry.isGlobal ? "g" : "l"}:${entry.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Resolves CSS nesting (`&`, implicit descendants) against parent selectors. */
export function resolveNestedSelectors(
  parentSelectors: readonly string[],
  childSelectors: readonly string[]
): string[] {
  if (parentSelectors.length === 0) return [...childSelectors];

  const resolved: string[] = [];
  for (const child of childSelectors) {
    for (const parent of parentSelectors) {
      if (child.includes("&")) {
        resolved.push(child.split("&").join(parent));
      } else {
        resolved.push(`${parent} ${child}`);
      }
    }
  }
  return resolved;
}
