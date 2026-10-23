import Link from "next/link";
import { type Locale, localizeHref, messages } from "@/lib/i18n";

const button =
  "inline-flex h-9 items-center rounded-md px-4 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring";

export function HomeHero({ lang }: { lang: Locale }) {
  return (
    <div className="not-prose mb-10 flex flex-col items-start gap-4 border-b pb-10">
      <span className="rounded-full border px-2.5 py-0.5 text-xs font-medium text-fd-muted-foreground">
        private alpha
      </span>
      <h1 className="text-3xl font-semibold tracking-tight">Werft</h1>
      <p className="text-lg text-fd-muted-foreground">
        {messages[lang].homeLead}
      </p>
      <div className="flex flex-wrap gap-3">
        <Link
          href={localizeHref("/getting-started/quickstart", lang)}
          className={`${button} bg-fd-primary text-fd-primary-foreground hover:bg-fd-primary/90`}
        >
          Quickstart
        </Link>
        <Link
          href={localizeHref("/sdk", lang)}
          className={`${button} border hover:bg-fd-accent`}
        >
          TypeScript SDK
        </Link>
      </div>
    </div>
  );
}
