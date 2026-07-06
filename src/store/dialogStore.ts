import { create } from "zustand";

/**
 * Pending confirmation request, if any. A component (e.g. close-tab) pushes a
 * request via `confirm(...)`; the `ConfirmDialog` renders it and resolves the
 * promise with the user's choice. Only one confirmation is shown at a time.
 */
export interface ConfirmRequest {
  title: string;
  message: string;
  /** Label for the destructive/primary action (default "Save"). */
  confirmLabel?: string;
  /** Label for the cancel action (default "Cancel"). */
  cancelLabel?: string;
  /** Label for a third "discard without saving" action (default "Don't Save"). */
  discardLabel?: string;
  resolve: (result: ConfirmResult) => void;
}

/** The outcome of a confirmation. */
export type ConfirmResult = "confirm" | "discard" | "cancel";

export interface DialogState {
  current: ConfirmRequest | null;
  /** Requests waiting behind the currently visible confirmation. */
  queue: ConfirmRequest[];
  /** Show a confirmation and await the user's choice. */
  confirm: (req: Omit<ConfirmRequest, "resolve">) => Promise<ConfirmResult>;
  /** Resolve the pending request (called by the dialog). */
  resolve: (result: ConfirmResult) => void;
}

export const useDialogStore = create<DialogState>()((set, get) => ({
  current: null,
  queue: [],
  confirm: (req) =>
    new Promise<ConfirmResult>((resolve) => {
      const request = { ...req, resolve };
      set((state) =>
        state.current === null
          ? { current: request }
          : { queue: [...state.queue, request] },
      );
    }),
  resolve: (result) => {
    const current = get().current;
    if (current === null) return;

    const [next, ...remaining] = get().queue;
    set({ current: next ?? null, queue: remaining });
    current.resolve(result);
  },
}));
