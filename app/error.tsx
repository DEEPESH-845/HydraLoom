"use client";

import Link from "next/link";

/** Anything a page throws while rendering. The message is shown; nothing is sent anywhere. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex h-full items-center justify-center p-6">
      <div className="panel w-full max-w-[560px] p-6" role="alert">
        <h1 className="text-[20px] font-medium leading-tight text-text">This page stopped working</h1>
        <p className="value mt-3 break-words text-[12px] leading-relaxed text-muted">{error.message || "Unknown error"}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={reset}>
            Try again
          </button>
          <Link href="/" prefetch={false} className="btn">
            Environments
          </Link>
        </div>
      </div>
    </main>
  );
}
