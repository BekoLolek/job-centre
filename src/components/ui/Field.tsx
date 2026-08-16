"use client";

import type { InputHTMLAttributes } from "react";
import FieldShell, { type FieldShellProps } from "./FieldShell";
import { cx } from "./cx";

/** Use for any text/number input on the `.field` surface; add `label` for the full row. */

export type FieldProps = FieldShellProps &
  Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
    /** Extra classes on the `<input>` itself. */
    className?: string;
  };

export default function Field({
  label,
  hint,
  error,
  wrapperClassName,
  className,
  ...rest
}: FieldProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} wrapperClassName={wrapperClassName}>
      <input className={cx("field", className)} {...rest} />
    </FieldShell>
  );
}
