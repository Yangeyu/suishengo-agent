import type { ComponentProps } from "react";
import styles from "@frontend/components/icon-button/index.module.css";

export function IconButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={[styles.iconButton, className].filter(Boolean).join(" ")}
    />
  );
}
