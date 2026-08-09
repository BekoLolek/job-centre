import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import DraftBoard from "./DraftBoard";

export const dynamic = "force-dynamic";

export default async function DraftPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  return <DraftBoard />;
}
