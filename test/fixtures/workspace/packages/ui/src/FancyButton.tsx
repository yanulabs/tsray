import { forwardRef } from "react";
import type { ButtonProps } from "./Button";

export const FancyButton = forwardRef((props: ButtonProps) => {
  return <button>{props.label}</button>;
});
