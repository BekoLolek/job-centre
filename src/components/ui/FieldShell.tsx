import type { ReactNode } from "react";
import { cx } from "./cx";

/** Internal: the shared label / hint / error wrapper behind Field, Select and Textarea. */

export type FieldShellProps = {
  label?: ReactNode;
  /** Quiet helper text under the control. */
  hint?: ReactNode;
  /** Validation message, rendered under the hint in ember. */
  error?: ReactNode;
  /** Extra classes on the wrapping `<label>` (the control itself takes `className`). */
  wrapperClassName?: string;
};

export default function FieldShell({
  label,
  hint,
  error,
  wrapperClassName,
  children,
}: FieldShellProps & { children: ReactNode }) {
  // Nothing to wrap with: hand back the bare control so the markup stays exactly as
  // authored at call sites that supply their own label.
  if (label === undefined && hint === undefined && error === undefined) return <>{children}</>;

  return (
    <label className={cx("block", wrapperClassName)}>
      {label !== undefined && (
        <span className="eyebrow block mb-2 text-chalk/70">{label}</span>
      )}
      {children}
      {hint !== undefined && <span className="eyebrow block mt-1 text-dim">{hint}</span>}
      {error !== undefined && <span className="block mt-1 text-xs text-ember">{error}</span>}
    </label>
  );
}
