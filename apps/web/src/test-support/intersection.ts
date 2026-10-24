/**
 * happy-dom's IntersectionObserver never reports. This one reports an
 * observed element as in view once `inView` says so: at observe, and again
 * on each show(). Everything is in view until a test says otherwise.
 */
export function fakeIntersection() {
  const live = new Set<FakeObserver>();
  let inView: (element: Element) => boolean = () => true;

  class FakeObserver {
    private readonly targets = new Set<Element>();
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.targets.add(target);
      live.add(this);
      queueMicrotask(() => this.report());
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
      live.delete(this);
    }
    takeRecords() {
      return [];
    }
    report() {
      const entries = [...this.targets]
        .filter((target) => inView(target))
        .map(
          (target) =>
            ({ target, isIntersecting: true }) as IntersectionObserverEntry,
        );
      if (entries.length > 0)
        this.callback(entries, this as unknown as IntersectionObserver);
    }
  }

  const original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver =
    FakeObserver as unknown as typeof IntersectionObserver;
  return {
    show(next: (element: Element) => boolean) {
      inView = next;
      for (const observer of live) observer.report();
    },
    restore() {
      inView = () => true;
      globalThis.IntersectionObserver = original;
    },
  };
}
