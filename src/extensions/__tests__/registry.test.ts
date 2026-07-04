import { describe, it, expect, beforeEach } from "vitest";
import { File } from "lucide-react";
import { viewRegistry, commandRegistry } from "../registry";

// A real lucide icon satisfies LucideIcon; () => null does not (it lacks the
// ForwardRefExoticComponent shape). The icon is never rendered in these tests.
const mockIcon = File;

describe("ViewRegistry", () => {
  beforeEach(() => {
    for (const v of viewRegistry.all()) viewRegistry.unregister(v.id);
  });

  it("registers and retrieves a view by id", () => {
    const view = {
      id: "test.view",
      title: "Test",
      icon: mockIcon,
      component: () => Promise.resolve({ default: () => null }),
      order: 0,
      when: "always" as const,
    };
    viewRegistry.register(view);
    expect(viewRegistry.get("test.view")).toBe(view);
  });

  it("returns views sorted by order", () => {
    viewRegistry.register({ id: "b", title: "B", icon: mockIcon, component: () => Promise.resolve({ default: () => null }), order: 20, when: "always" });
    viewRegistry.register({ id: "a", title: "A", icon: mockIcon, component: () => Promise.resolve({ default: () => null }), order: 10, when: "always" });
    const ids = viewRegistry.all().map((v) => v.id);
    expect(ids).toEqual(["a", "b"]);
  });

  it("ignores duplicate id with a warning", () => {
    const v = { id: "dup", title: "Dup", icon: mockIcon, component: () => Promise.resolve({ default: () => null }), order: 0, when: "always" as const };
    viewRegistry.register(v);
    viewRegistry.register({ ...v, title: "Dup2" });
    expect(viewRegistry.get("dup")?.title).toBe("Dup");
  });

  it("notifies subscribers on register/unregister", () => {
    let calls = 0;
    const unsub = viewRegistry.subscribe(() => calls++);
    viewRegistry.register({ id: "x", title: "X", icon: mockIcon, component: () => Promise.resolve({ default: () => null }), order: 0, when: "always" });
    viewRegistry.unregister("x");
    expect(calls).toBe(2);
    unsub();
  });
});

describe("CommandRegistry", () => {
  beforeEach(() => {
    for (const c of commandRegistry.all()) commandRegistry.unregister(c.id);
  });

  it("registers and retrieves a command by id", () => {
    const cmd = { id: "test.cmd", title: "Test", handler: () => {} };
    commandRegistry.register(cmd);
    expect(commandRegistry.get("test.cmd")).toBe(cmd);
  });
});
