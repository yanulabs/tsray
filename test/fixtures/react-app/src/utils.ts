export function add(a: number, b: number): number {
  return a + b;
}

export function deadRoot(): number {
  return localHelper(2);
}

function localHelper(value: number): number {
  return value * 2;
}
