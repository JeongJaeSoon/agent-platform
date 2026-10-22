import Link from "next/link";

const button =
  "inline-flex h-9 items-center rounded-md px-4 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring";

export function HomeHero() {
  return (
    <div className="not-prose mb-10 flex flex-col items-start gap-4 border-b pb-10">
      <span className="rounded-full border px-2.5 py-0.5 text-xs font-medium text-fd-muted-foreground">
        private alpha
      </span>
      <h1 className="text-3xl font-semibold tracking-tight">Werft</h1>
      <p className="text-lg text-fd-muted-foreground">
        격리된 worker에서 Claude Agent SDK 세션을 실행하고,
        시작·이벤트·승인·제어를 HTTP API로 다루는 플랫폼입니다.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link
          href="/getting-started/quickstart"
          className={`${button} bg-fd-primary text-fd-primary-foreground hover:bg-fd-primary/90`}
        >
          Quickstart
        </Link>
        <Link href="/sdk" className={`${button} border hover:bg-fd-accent`}>
          TypeScript SDK (API 클라이언트)
        </Link>
      </div>
    </div>
  );
}
