import { redirect } from "next/navigation";

/** The field workspace moved to the root route; old links keep working and keep their workspace. */
export default async function FieldPage({ searchParams }: { searchParams: Promise<{ ws?: string }> }) {
  const { ws } = await searchParams;
  redirect(ws ? `/?ws=${encodeURIComponent(ws)}` : "/");
}
