"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Avatar, cx } from "@/components/ui";

/**
 * The account menu: an avatar and a name that open a panel of links.
 *
 * This replaces a row of four bordered buttons. Four boxes side by side read as
 * one object — you see a block of chrome rather than four choices — which is
 * why the top bar felt crowded no matter how few links were in it. One control
 * that opens a list is quieter at rest and roomier when open, and it has
 * somewhere to put the things a top bar has no space for.
 *
 * Deliberately not a `<details>`: the menu has to close on outside click and on
 * Escape, and it has to know the current route to mark a link as current.
 */

export type NavMenuUser = {
  displayName: string | null;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
};

type Item = { href: string; label: string; hint?: string };

const MEMBER: Item[] = [
  { href: "/me", label: "Dashboard", hint: "What needs you next" },
  { href: "/me/events", label: "My events", hint: "Applications and availability" },
  { href: "/me/profile", label: "Profile", hint: "Ranks, roles, in-game names" },
  { href: "/host", label: "Host an event", hint: "Propose one, or open yours" },
];

const ADMIN: Item[] = [
  { href: "/admin", label: "Tonight", hint: "What needs attention" },
  { href: "/admin/events", label: "Events" },
  { href: "/admin/host", label: "Host applications", hint: "Who wants to run something" },
  { href: "/admin/availability", label: "Availability", hint: "When everyone is free" },
  { href: "/admin/templates", label: "Templates" },
  { href: "/admin/games", label: "Games and questions" },
  { href: "/admin/users", label: "Members" },
  { href: "/admin/audit", label: "Audit log" },
  { href: "/admin/settings", label: "Settings" },
];

export default function NavMenu({
  user,
  signOut,
}: {
  user: NavMenuUser;
  /** The sign-out server action, handed down so this stays a pure client leaf. */
  signOut: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pathname = usePathname() ?? "";
  const name = user.displayName ?? user.name ?? "Member";

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const group = (items: Item[]) =>
    items.map((item) => {
      const current =
        item.href === "/me" || item.href === "/admin"
          ? pathname === item.href
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
      return (
        <Link
          key={item.href}
          href={item.href}
          aria-current={current ? "page" : undefined}
          className={cx(
            "block px-4 py-2.5 transition-colors",
            current ? "bg-union/10 text-hot" : "text-chalk/85 hover:bg-white/[0.04] hover:text-hot"
          )}
        >
          <span className="block text-sm leading-tight">{item.label}</span>
          {item.hint && (
            <span className="mt-0.5 block text-[11px] leading-tight text-muted">{item.hint}</span>
          )}
        </Link>
      );
    });

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cx(
          "flex items-center gap-2.5 rounded-full py-1 pl-1 pr-3 transition-colors",
          open ? "bg-white/[0.06]" : "hover:bg-white/[0.04]"
        )}
      >
        <Avatar name={name} size="sm" />
        <span className="hidden text-sm text-chalk/90 sm:block">{name}</span>
        <svg
          viewBox="0 0 10 6"
          aria-hidden
          className={cx(
            "h-1.5 w-2.5 text-muted transition-transform",
            open && "rotate-180"
          )}
        >
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-hair bg-panel py-1.5 shadow-[0_18px_50px_-20px_rgba(0,0,0,0.9)]"
        >
          <div className="border-b border-hair px-4 pb-3 pt-2">
            <p className="text-sm leading-tight text-chalk">{name}</p>
            {user.handle && (
              <Link
                href={`/players/${user.handle}`}
                className="num text-[11px] text-muted transition-colors hover:text-union"
              >
                /players/{user.handle}
              </Link>
            )}
          </div>

          <div className="py-1">{group(MEMBER)}</div>

          {user.isAdmin && (
            <>
              <p className="eyebrow border-t border-hair px-4 pb-1.5 pt-3">Admin</p>
              <div className="pb-1">{group(ADMIN)}</div>
            </>
          )}

          <form action={signOut} className="border-t border-hair pt-1">
            <button
              type="submit"
              className="block w-full px-4 py-2.5 text-left text-sm text-muted transition-colors hover:bg-white/[0.04] hover:text-flare"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
