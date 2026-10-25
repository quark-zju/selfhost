import { useEffect, useRef, useState } from "react";
import { HoldAction } from "./holdAction";
import { locale } from "./locales/index.ts";

export function HoldDelete({
  name,
  disabled,
  onDelete,
}: {
  name: string;
  disabled: boolean;
  onDelete: () => void;
}) {
  const node = useRef<HTMLButtonElement>(null);
  const action = useRef(onDelete);
  action.current = onDelete;
  const [holding, setHolding] = useState(false);
  const [hold] = useState(
    () => new HoldAction(() => action.current(), setHolding),
  );
  useEffect(() => {
    const doc = node.current!.ownerDocument;
    const cancel = () => hold.cancel();
    doc.addEventListener("visibilitychange", cancel);
    doc.defaultView?.addEventListener("blur", cancel);
    return () => {
      hold.cancel();
      doc.removeEventListener("visibilitychange", cancel);
      doc.defaultView?.removeEventListener("blur", cancel);
    };
  }, [hold]);
  useEffect(() => {
    if (disabled) hold.cancel();
  }, [disabled, hold]);
  return (
    <button
      ref={node}
      className={`row-action delete-canvas${holding ? " holding" : ""}`}
      title={locale.Gallery.DeleteHint}
      aria-label={locale.Gallery.DeleteLabel(name)}
      disabled={disabled}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        hold.start();
      }}
      onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          hold.cancel();
      }}
      onPointerUp={() => hold.cancel()}
      onPointerCancel={() => hold.cancel()}
      onPointerLeave={() => hold.cancel()}
      onLostPointerCapture={() => hold.cancel()}
      onBlur={() => hold.cancel()}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        if (!event.repeat) hold.start();
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          hold.cancel();
        }
      }}
      onClick={(event) => event.preventDefault()}
    >
      <svg
        viewBox="0 0 32 32"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <circle className="delete-outline" cx="16" cy="16" r="12" />
        <circle
          className="hold-progress"
          cx="16"
          cy="16"
          r="12"
          pathLength="100"
        />
        <path d="m12 12 8 8m0-8-8 8" strokeLinecap="round" />
      </svg>
    </button>
  );
}
