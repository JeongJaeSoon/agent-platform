/**
 * happy-dom's IntersectionObserver never reports. This one reports every
 * observed element, in view or not as `inView` says, at observe and again on
 * each show(), as a real one reports at observe. Everything is in view until
 * a test says otherwise.
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
      const entries = [...this.targets].map(
        (target) =>
          ({
            target,
            isIntersecting: inView(target),
          }) as IntersectionObserverEntry,
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
