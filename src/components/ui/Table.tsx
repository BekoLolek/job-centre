import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cx } from "./cx";

/** Use for any data grid that should read like the standings table. Wrap in a Panel. */

export type TableAlign = "left" | "right";

const ALIGN: Record<TableAlign, string> = {
  left: "text-left",
  right: "text-right",
};

/** The `<table>` itself — pass a `min-w-[…]` so the Panel can scroll it horizontally. */
export function Table({ className, children }: { className?: string; children?: ReactNode }) {
  return <table className={cx("w-full text-sm", className)}>{children}</table>;
}

/** Renders both the `<thead>` and its single hairline-ruled `<tr>`. */
export function TableHead({ children }: { children?: ReactNode }) {
  return (
    <thead>
      <tr className="border-b border-hair/70">{children}</tr>
    </thead>
  );
}

export function TableBody({ children }: { children?: ReactNode }) {
  return <tbody>{children}</tbody>;
}

/** A body row, hairline-ruled except for the last one. */
export function TableRow({ className, children }: { className?: string; children?: ReactNode }) {
  return <tr className={cx("border-b border-hair/40 last:border-0", className)}>{children}</tr>;
}

export type TableHeadCellProps = {
  align?: TableAlign;
  className?: string;
  children?: ReactNode;
} & Omit<ThHTMLAttributes<HTMLTableCellElement>, "className" | "children" | "align">;

/** A header cell — eyebrow type, left aligned unless told otherwise. */
export function TableHeadCell({
  align = "left",
  className,
  children,
  ...rest
}: TableHeadCellProps) {
  return (
    <th className={cx("eyebrow px-3 py-2", ALIGN[align], className)} {...rest}>
      {children}
    </th>
  );
}

export type TableCellProps = {
  /** Tabular numerals via `.num` — use for every score, count or money column. */
  numeric?: boolean;
  align?: TableAlign;
  className?: string;
  children?: ReactNode;
} & Omit<TdHTMLAttributes<HTMLTableCellElement>, "className" | "children" | "align">;

export function TableCell({ numeric, align, className, children, ...rest }: TableCellProps) {
  return (
    <td
      className={cx(numeric && "num", "px-3 py-2", align && ALIGN[align], className)}
      {...rest}
    >
      {children}
    </td>
  );
}
