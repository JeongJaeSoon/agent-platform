import type { RequestOptions } from "./request.ts";

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  /** null on the last page. Options default to the first call's; the ones given here win. */
  nextPage(options?: RequestOptions): Promise<Page<T> | null>;
}

/** `await` gives the first page; `for await` walks every item of every page. */
export interface PagePromise<T> extends Promise<Page<T>>, AsyncIterable<T> {}

type Fetch<T> = (
  cursor: string | undefined,
  options: RequestOptions | undefined,
) => Promise<{ items: T[]; next_cursor: string | null }>;

function page<T>(
  fetch: Fetch<T>,
  body: { items: T[]; next_cursor: string | null },
  options: RequestOptions | undefined,
): Page<T> {
  return {
    items: body.items,
    next_cursor: body.next_cursor,
    async nextPage(overrides) {
      if (body.next_cursor === null) return null;
      const merged = { ...options, ...overrides };
      return page(fetch, await fetch(body.next_cursor, merged), merged);
    },
  };
}

export function paginate<T>(
  fetch: Fetch<T>,
  options: RequestOptions | undefined,
): PagePromise<T> {
  const first = fetch(undefined, options).then((body) =>
    page(fetch, body, options),
  );
  return Object.assign(first, {
    async *[Symbol.asyncIterator]() {
      let current: Page<T> | null = await first;
      while (current) {
        yield* current.items;
        current = await current.nextPage();
      }
    },
  });
}
