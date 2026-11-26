/**
 * CSS Modules export-locals conventions differ across bundlers. A source class
 * such as `.btn-primary` may be imported as `styles.btnPrimary`, while
 * `styles["btn-primary"]` remains valid too. These helpers compare the small
 * set of conventional spellings without coupling callers to a bundler config.
 */

function classNameVariants(name: string): string[] {
  const kebab = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-");
  const camel = name.replace(/[-_]+(.)/g, (_match, char: string) => char.toUpperCase());
  return [...new Set([name, kebab, camel])];
}

export function classNamesMatch(left: string, right: string): boolean {
  const rightVariants = classNameVariants(right);
  return classNameVariants(left).some((variant) => rightVariants.includes(variant));
}

export function hasMatchingClass(
  classes: Iterable<string>,
  candidate: string
): boolean {
  for (const className of classes) {
    if (classNamesMatch(className, candidate)) return true;
  }
  return false;
}
