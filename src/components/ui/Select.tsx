"use client";

import type { SelectHTMLAttributes } from "react";
import FieldShell, { type FieldShellProps } from "./FieldShell";
import { cx } from "./cx";

/** Use for dropdowns — same `.field` chrome and label/hint/error handling as Field. */

export type SelectProps = FieldShellProps &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> & {
    /** Extra classes on the `<select>` itself. */
    className?: string;
  };

export default function Select({
  label,
  hint,
  error,
  wrapperClassName,
  className,
  children,
  ...rest
}: SelectProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} wrapperClassName={wrapperClassName}>
      <select className={cx("field", className)} {...rest}>
        {children}
      </select>
    </FieldShell>
  );
}
