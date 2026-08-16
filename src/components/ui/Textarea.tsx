"use client";

import type { TextareaHTMLAttributes } from "react";
import FieldShell, { type FieldShellProps } from "./FieldShell";
import { cx } from "./cx";

/** Use for multi-line input — same `.field` chrome and label/hint/error handling as Field. */

export type TextareaProps = FieldShellProps &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> & {
    /** Extra classes on the `<textarea>` itself — height and resize live here. */
    className?: string;
  };

export default function Textarea({
  label,
  hint,
  error,
  wrapperClassName,
  className,
  ...rest
}: TextareaProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} wrapperClassName={wrapperClassName}>
      <textarea className={cx("field", className)} {...rest} />
    </FieldShell>
  );
}
