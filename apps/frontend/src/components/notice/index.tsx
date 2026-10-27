import type { ComponentProps } from "react";
import styles from "@frontend/components/notice/index.module.css";

export function Notice({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      role="status"
      {...props}
      className={[styles.notice, className].filter(Boolean).join(" ")}
    />
  );
}
