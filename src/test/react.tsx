import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactElement } from "react";

/**
 * Shared React render harness for component/hook tests (jsdom +
 * `createRoot`, no Testing Library dependency). One instance per test file
 * replaces the hand-rolled `let container/root` + `render()` + `cleanup()`
 * boilerplate every suite used to carry:
 *
 * ```tsx
 * const h = reactHarness();
 * afterEach(h.cleanup);
 * // per test:
 * const container = h.render(<Thing />);
 * // or, when mount effects + microtasks must settle (viewers that fetch):
 * await h.renderAsync(<Thing />);
 * ```
 *
 * `cleanup` is idempotent (double afterEach registration is harmless) and
 * tolerates a never-rendered harness.
 */
export interface ReactHarness {
  /** The mounted container (throws before the first render). */
  readonly container: HTMLDivElement;
  /** Mount `ui` synchronously inside `act`. */
  render(ui: ReactElement): HTMLDivElement;
  /** Mount `ui` inside an async `act` so effects + microtasks settle. */
  renderAsync(ui: ReactElement): Promise<HTMLDivElement>;
  /** Re-render the mounted root inside `act`. */
  rerender(ui: ReactElement): void;
  /** Unmount the mounted root inside `act` (keeps the container in the DOM). */
  unmount(): void;
  /** Unmount and detach the container; safe to call repeatedly. */
  cleanup(): void;
}

// React 19 requires the flag for act() outside a real test renderer; set it
// once for every suite that imports the harness.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

export function reactHarness(): ReactHarness {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const mount = (): HTMLDivElement => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    return container;
  };

  return {
    get container(): HTMLDivElement {
      if (container === null) {
        throw new Error("reactHarness: render() before reading .container");
      }
      return container;
    },
    render(ui) {
      const c = mount();
      act(() => root?.render(ui));
      return c;
    },
    async renderAsync(ui) {
      const c = mount();
      await act(async () => {
        root?.render(ui);
      });
      return c;
    },
    rerender(ui) {
      act(() => root?.render(ui));
    },
    unmount() {
      act(() => root?.unmount());
    },
    cleanup() {
      if (root !== null && container !== null) {
        const r = root;
        act(() => r.unmount());
        container.remove();
      }
      root = null;
      container = null;
    },
  };
}
