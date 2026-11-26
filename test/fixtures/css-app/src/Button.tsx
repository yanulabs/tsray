import "./legacy.scss";
import styles from "./Button.module.css";
import dynamicStyles from "./Dynamic.module.css";
import panelStyles from "@/styles/Panel.module.css";

function clsx(...values: unknown[]): string {
  return values.filter(Boolean).join(" ");
}

export interface ButtonProps {
  active: boolean;
  variant: "primary" | "secondary";
}

export function Button({ active, variant }: ButtonProps) {
  const content = `${styles.root} ${active ? styles.primary : ""}`;
  return (
    <button className={content}>
      <span className={panelStyles.panel} />
      <span className={panelStyles["panelTitle"]} />
      <span className={panelStyles.iconButton} />
      <span className={styles[variant]} />
      <span className={`${styles.root} literal`} />
      <span className={styles.absent} />
    </button>
  );
}

export function Toggle({ open }: { open: boolean }) {
  const computed = clsx("dynamic-root", dynamicStyles.alpha);
  const partial = `prefix-${dynamicStyles.alpha}`;
  return (
    <>
      <div
        className={clsx("toggle", open && styles.primary, {
          [styles.secondary]: open,
          [styles.toggled]: open,
        })}
      />
      <span className={computed} />
      <span className={partial} />
      <span className="used-global" />
      <span className={`${styles.root} trimmed`.trim()} />
      <span className={[styles.primary, "array-class"].filter(Boolean).join(" ")} />
      <span labelClassName="label-class" />
      <span classNames={{ slot: "slot-class" }} />
      <span className="sm:hidden" />
    </>
  );
}

export function Badge({ variant }: { variant: "new" | "hot" }) {
  return <span className={`badge-${variant}`} />;
}

export function DynamicTone({ tone }: { tone: string }) {
  return <div className={`tone-${tone}`} />;
}

export function attachTheme() {
  (globalThis as any).document.documentElement.classList.add("dark-mode");
  (globalThis as any).document.documentElement.className = "light-mode";
}
