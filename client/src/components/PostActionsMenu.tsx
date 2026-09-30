import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

export interface MenuAction {
  key: string;
  label: string;
  icon?: ReactNode;
  /** Runs the action (buttons) */
  onSelect?: () => void;
  /** Opens a link in a new tab instead (e.g. Xem trên Facebook) */
  href?: string;
  danger?: boolean;
  /** Two-step: the first select shows this text, the second runs the action */
  confirmLabel?: string;
}

/** "⋯" menu for one post. Keyboard: Enter/Space opens, ↑/↓ move, Esc closes and returns focus. */
export default function PostActionsMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const [arming, setArming] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const items = () => [...(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const close = (focusTrigger = true) => {
    setOpen(false);
    setArming(null);
    if (focusTrigger) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    if (!open) return;
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    }
  }

  function run(a: MenuAction) {
    if (a.confirmLabel && arming !== a.key) return setArming(a.key);
    a.onSelect?.();
    close();
  }

  if (!actions.length) return null;
  return (
    <div className="actions-menu" ref={rootRef} onKeyDown={onMenuKey} onClick={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        aria-label={label}
        title="Thao tác"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <MoreHorizontal size={17} aria-hidden="true" />
      </button>
      {open && (
        <div className="actions-menu-list" role="menu" id={menuId} aria-label={label}>
          {actions.map((a) =>
            a.href ? (
              <a key={a.key} role="menuitem" tabIndex={-1} className="actions-menu-item" href={a.href} target="_blank" rel="noreferrer" onClick={() => close()}>
                {a.icon}
                {a.label}
              </a>
            ) : (
              <button key={a.key} type="button" role="menuitem" tabIndex={-1} className={`actions-menu-item ${a.danger ? 'danger' : ''}`} onClick={() => run(a)}>
                {a.icon}
                {arming === a.key ? a.confirmLabel : a.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
