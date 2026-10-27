import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "@frontend/components/markdown/index.module.css";

export function Markdown({ children }: { children: string }) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
