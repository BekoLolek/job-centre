import type { Metadata } from "next";
import { Anton, Familjen_Grotesk, Azeret_Mono } from "next/font/google";
import "./globals.css";

const display = Anton({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
  display: "swap",
});

const body = Familjen_Grotesk({
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
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body className="grain">
        <div className="stage min-h-screen">{children}</div>
      </body>
    </html>
  );
}
