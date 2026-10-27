import styles from "@frontend/components/loading-indicator/index.module.css";

export function LoadingIndicator() {
  return <span className={styles.loadingDot} aria-hidden="true" />;
}
