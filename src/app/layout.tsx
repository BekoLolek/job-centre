import type { Metadata } from "next";
import DevLoginBanner from "@/components/DevLoginBanner";
import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Job Centre Events",
  description: "Draft boards, schedules and live results for Job Centre community events",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fontVariables}>
      <body>
        <div className="stage min-h-screen">{children}</div>
        {/* Renders nothing unless the development sign-in is switched on. */}
        <DevLoginBanner />
      </body>
    </html>
  );
}
