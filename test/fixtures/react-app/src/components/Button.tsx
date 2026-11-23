import { memo } from "react";

export interface ButtonProps {
  label: string;
}

export function Button({ label }: ButtonProps) {
  return <button>{label}</button>;
}

export const MemoButton = memo(Button);
