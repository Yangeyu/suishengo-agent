import { useEffect, useRef, useState } from "react";
import type { SessionAction } from "@frontend/features/sessions/types";
import styles from "@frontend/features/sessions/components/session-dialog/index.module.css";

export function SessionDialog({
  action,
  onClose,
  onSave,
}: {
  action: SessionAction;
  onClose(): void;
  onSave(title: string): Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(action.session.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const rename = action.kind === "rename";
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={styles.sessionDialog}
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        if (saving) event.preventDefault();
        else onClose();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving) return;
          setSaving(true);
          setError("");
          try {
            await onSave(title.trim());
          } catch (error) {
            setError((error as Error).message);
            setSaving(false);
          }
        }}
      >
        <h2 id="dialog-title">{rename ? "重命名对话" : "删除这段对话？"}</h2>
        {rename ? (
          <label>
            对话名称
            <input
              autoFocus
              value={title}
              maxLength={100}
              disabled={saving}
              onChange={(event) => setTitle(event.target.value)}
              onFocus={(event) => event.target.select()}
            />
          </label>
        ) : (
          <p>“{action.session.title}”的消息和记录将被永久删除，无法恢复。</p>
        )}
        {error && (
          <p className={styles.dialogError} role="alert">
            {error}
          </p>
        )}
        <div className={styles.dialogActions}>
          <button type="button" autoFocus={!rename} disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            className={rename ? styles.primary : styles.danger}
            disabled={saving || (rename && !title.trim())}
            type="submit"
          >
            {saving ? "处理中…" : rename ? "保存" : "删除对话"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
