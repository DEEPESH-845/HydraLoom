import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex h-full items-center justify-center p-6">
      <div className="panel w-full max-w-[560px] p-6">
        <h1 className="text-[20px] font-medium leading-tight text-text">There is no page here</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">The link may be old. The workspaces are still where they were.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link href="/" prefetch={false} className="btn btn-primary">
            Environments
          </Link>
          <Link href="/lab" prefetch={false} className="btn">
            Gantry Lab
          </Link>
          <Link href="/benchmark" className="btn">
            Benchmark
          </Link>
        </div>
      </div>
    </main>
  );
}
