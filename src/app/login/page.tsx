import { redirect } from "next/navigation";
import { Eyebrow } from "@/components/ui";
import { getSession } from "@/lib/session";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect("/draft");

  return (
    <main className="min-h-screen grid lg:grid-cols-[1.15fr_1fr]">
      <section className="relative hidden lg:flex flex-col justify-between p-12 border-r border-hair overflow-hidden">
        <Eyebrow className="rise">Auction Board · Access Restricted</Eyebrow>

        <div className="relative">
          <h1 className="font-display leading-[0.82] tracking-tight">
            <span className="block text-[clamp(3rem,8vw,7.5rem)] rise">JOB CENTRE</span>
            <span
              className="block text-[clamp(3rem,8vw,7.5rem)] text-gold rise"
              style={{ animationDelay: "90ms" }}
            >
              EVENTS
            </span>
          </h1>
          <p
            className="mt-6 max-w-md text-muted leading-relaxed rise"
            style={{ animationDelay: "180ms" }}
          >
            One wheel. Four captains. Sealed bids. The highest number takes the player
            and pays the price.
          </p>
        </div>

        <Eyebrow className="flex items-center gap-3 rise" style={{ animationDelay: "260ms" }}>
          <span className="inline-block h-2 w-2 rounded-full bg-ember live-dot" />
          Captains only
        </Eyebrow>

        <div className="pointer-events-none absolute -right-24 top-1/2 -translate-y-1/2 h-[520px] w-[520px] rounded-full border border-hair hatch opacity-40" />
        <div className="pointer-events-none absolute -right-10 top-1/2 -translate-y-1/2 h-[340px] w-[340px] rounded-full border border-hair opacity-30" />
      </section>

      <section className="flex items-center justify-center p-6 sm:p-12">
        <LoginForm />
      </section>
    </main>
  );
}
