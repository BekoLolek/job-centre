import type { Metadata } from "next";
import { Archivo, Azeret_Mono, Chakra_Petch, Michroma } from "next/font/google";
import DevLoginBanner from "@/components/DevLoginBanner";
import "./globals.css";

/**
 * Four faces, each with one job.
 *
 * `Chakra Petch` is the display face: angular, technical, cut on the diagonal —
 * the same angle the saltire in the background runs at, which is why it sits on
 * this design rather than a rounder geometric one. `Michroma` is wide and
 * engineered and is used for exactly one thing, the wordmark, so the site has a
 * signature that appears nowhere else. `Archivo` carries body copy because it
 * stays readable at 12px, which most characterful faces do not.
 *
 * `Azeret Mono` is unchanged. Every table, score and timer on the site is
 * measured against its figures, and swapping a mono is how a redesign quietly
 * breaks a standings table.
 */
const display = Chakra_Petch({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

const wordmark = Michroma({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-wordmark",
  display: "swap",
});

const body = Archivo({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

const mono = Azeret_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Job Centre Events",
  description: "Draft boards, schedules and live results for Job Centre community events",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${wordmark.variable} ${body.variable} ${mono.variable}`}
    >
      <body className="grain">
        <div className="stage min-h-screen">{children}</div>
        {/* Renders nothing unless the development sign-in is switched on. */}
        <DevLoginBanner />
      </body>
    </html>
  );
}
