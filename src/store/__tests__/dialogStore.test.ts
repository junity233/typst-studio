import { beforeEach, describe, expect, it } from "vitest";
import { useDialogStore } from "../dialogStore";

describe("dialogStore", () => {
  beforeEach(() => {
    useDialogStore.setState({ current: null, queue: [] });
  });

  it("queues concurrent confirmations instead of orphaning the first promise", async () => {
    const first = useDialogStore.getState().confirm({
      title: "First",
      message: "First message",
    });
    const second = useDialogStore.getState().confirm({
      title: "Second",
      message: "Second message",
    });

    expect(useDialogStore.getState().current?.title).toBe("First");
    expect(useDialogStore.getState().queue).toHaveLength(1);

    useDialogStore.getState().resolve("confirm");
    await expect(first).resolves.toBe("confirm");
    expect(useDialogStore.getState().current?.title).toBe("Second");

    useDialogStore.getState().resolve("cancel");
    await expect(second).resolves.toBe("cancel");
    expect(useDialogStore.getState().current).toBeNull();
  });
});
