"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Eyebrow from "./Eyebrow";
import { cx } from "./cx";

/**
 * Use for the small focused dialog — add a question, confirm a delete.
 *
 * The plan lists Modal in §5's component set; this is the minimum that behaves:
 * Escape closes, a click on the backdrop closes, focus moves into the dialog on
 * open and the page behind it does not scroll. Nothing more — a modal that
 * grows features is a page that should have been a route.
 */

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Small mono line under the title — context, not instructions. */
  eyebrow?: ReactNode;
  /** The action row, pinned under the body. */
  footer?: ReactNode;
  /** `sm` for a confirm, `md` for a form. */
  size?: "sm" | "md";
  children?: ReactNode;
};

export default function Modal({
  open,
  onClose,
  title,
  eyebrow,
  footer,
  size = "md",
  children,
}: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Focus the first control so the keyboard lands inside the dialog rather
    // than on whatever was behind it.
    const focusable = panel.current?.querySelector<HTMLElement>(
      "input, select, textarea, button, [tabindex]:not([tabindex='-1'])"
    );
    focusable?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/80 p-4 backdrop-blur-sm sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        className={cx(
          "panel my-8 w-full",
          size === "sm" ? "max-w-md" : "max-w-lg"
        )}
      >
        <div className="border-b border-hair p-5">
          {eyebrow && <Eyebrow className="mb-2">{eyebrow}</Eyebrow>}
          <h2 className="font-display text-xl leading-tight">{title}</h2>
        </div>

        <div className="space-y-4 p-5">{children}</div>

        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-hair p-5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
