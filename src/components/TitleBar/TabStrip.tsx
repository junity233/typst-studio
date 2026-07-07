import { useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Copy,
  FolderX,
  RotateCcw,
  SquareArrowOutUpRight,
  X,
  XSquare,
} from "lucide-react";
import { useTabsStore } from "../../store/tabsStore";
import { useDocumentsStore } from "../../store/documentsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import {
  closeOtherTabs,
  closeSavedTabs,
  closeTabWithConfirm,
  closeTabsToTheRight,
  closeAllTabs,
} from "../../lib/commands";
import { revealInFinder } from "../../lib/tauri";
import { isMac } from "../../lib/platform";
import {
  isInWorkspace,
  relativeWithinWorkspace,
} from "../../lib/workspacePath";
import { useContextMenuStore, type MenuItem } from "../Sidebar/contextMenuStore";

const ICON_SIZE = 14;

export function TabStrip() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const activate = useTabsStore((s) => s.activate);
  const openTab = useTabsStore((s) => s.openTab);
  const reactivate = useTabsStore((s) => s.reactivate);
  // Subscribe to the documents map so the dirty indicator updates live.
  const documents = useDocumentsStore((s) => s.documents);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const openMenu = useContextMenuStore((s) => s.open);
  const { t } = useTranslation("titlebar");
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const rovingId = activeId ?? tabs[0] ?? null;

  const focusAndActivate = (id: string) => {
    activate(id);
    tabRefs.current.get(id)?.focus();
  };

  /** Copy text to the system clipboard, warning (not throwing) on failure. */
  const copyToClipboard = (text: string) => {
    navigator.clipboard?.writeText(text).catch((e) => {
      console.warn("[TabStrip] clipboard write failed:", e);
    });
  };

  /** Reveal a tab's backing file in the OS file manager. */
  const revealTab = (path: string) => {
    // reveal_in_finder takes a workspace-relative path; only workspace-backed
    // files can be revealed this way. relativeWithinWorkspace is separator- and
    // case-insensitive on Windows (a raw startsWith(root + "/") check fails on
    // backslash roots like C:\code\...).
    const rel = relativeWithinWorkspace(rootPath, path);
    if (rel === null) return;
    void revealInFinder(rel).catch((e) => {
      // No toast system; log clearly. The reveal IPC surfaces a structured
      // error in production via the global error handler.
      console.warn("[TabStrip] reveal failed:", e);
    });
  };

  /** Build + open the right-click menu for a single tab. */
  const openTabMenu = (id: string, x: number, y: number) => {
    const state = useTabsStore.getState();
    const doc = useDocumentsStore.getState().documents[id];
    const hidden = state.hidden ?? [];
    const idx = state.tabs.indexOf(id);
    const title = doc?.title ?? id;
    const isLast = idx === state.tabs.length - 1;
    // Reveal is only meaningful for a workspace-backed file (reveal_in_finder
    // resolves a workspace-relative path). isInWorkspace is separator- and
    // case-insensitive on Windows so backslash roots (C:\code\...) match.
    const path = doc?.path ?? null;
    const inWs = path !== null && isInWorkspace(rootPath, path);
    const hasSavedTabs = state.tabs.some(
      (tid) => !(useDocumentsStore.getState().documents[tid]?.dirty ?? false),
    );

    const items: MenuItem[] = [
      {
        type: "action",
        label: t("tabClose"),
        icon: <X size={ICON_SIZE} />,
        onSelect: () => void closeTabWithConfirm(id),
      },
      {
        type: "action",
        label: t("tabCloseOthers"),
        disabled: state.tabs.length <= 1,
        onSelect: () => void closeOtherTabs(id),
      },
      {
        type: "action",
        label: t("tabCloseRight"),
        disabled: isLast,
        onSelect: () => void closeTabsToTheRight(id),
      },
      {
        type: "action",
        label: t("tabCloseAll"),
        icon: <XSquare size={ICON_SIZE} />,
        onSelect: () => void closeAllTabs(),
      },
      {
        type: "action",
        label: t("tabCloseSaved"),
        disabled: !hasSavedTabs,
        onSelect: () => void closeSavedTabs(),
      },
      { type: "separator" },
    ];

    // Copy Path submenu — only for titled (file-backed) tabs.
    if (path !== null) {
      items.push({
        type: "submenu",
        label: t("tabCopyPath"),
        children: [
          {
            type: "action",
            label: t("tabCopyName"),
            icon: <Copy size={ICON_SIZE} />,
            onSelect: () => copyToClipboard(title),
          },
          {
            type: "action",
            label: t("tabCopyAbsolutePath"),
            icon: <Copy size={ICON_SIZE} />,
            onSelect: () => copyToClipboard(path),
          },
        ],
      });
    }

    // Reveal — only for workspace-backed files.
    if (inWs && path !== null) {
      items.push({
        type: "action",
        label: isMac
          ? t("tabRevealInFinder")
          : t("tabRevealInFileExplorer"),
        icon: <SquareArrowOutUpRight size={ICON_SIZE} />,
        onSelect: () => revealTab(path),
      });
    } else if (path !== null) {
      // File exists but lives OUTSIDE the workspace — reveal isn't supported by
      // the workspace-relative API; show it disabled so the menu reads complete.
      items.push({
        type: "action",
        label: isMac
          ? t("tabRevealInFinder")
          : t("tabRevealInFileExplorer"),
        icon: <FolderX size={ICON_SIZE} />,
        disabled: true,
        onSelect: () => {},
      });
    }

    items.push(
      { type: "separator" },
      {
        type: "action",
        label: t("tabReopenClosed"),
        icon: <RotateCcw size={ICON_SIZE} />,
        disabled: hidden.length === 0,
        onSelect: () => {
          // hidden is LRU: last entry = most-recently-closed.
          const last = hidden[hidden.length - 1];
          if (last) void reactivate(last);
        },
      },
    );

    openMenu(items, x, y);
  };

  return (
    <div className="tabstrip" role="tablist" aria-label={t("openDocuments")}>
      {tabs.map((id) => {
        const active = id === activeId;
        const doc = documents[id];
        const title = doc?.title ?? id;
        const dirty = doc?.dirty ?? false;
        return (
          <div
            key={id}
            className={"tab" + (active ? " tab-active" : "")}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openTabMenu(id, e.clientX, e.clientY);
            }}
          >
            <button
              ref={(element) => {
                if (element) tabRefs.current.set(id, element);
                else tabRefs.current.delete(id);
              }}
              className="tab-select"
              type="button"
              role="tab"
              tabIndex={id === rovingId ? 0 : -1}
              aria-selected={active}
              onClick={() => activate(id)}
              onKeyDown={(event) => {
                const index = tabs.indexOf(id);
                let target: string | undefined;
                if (event.key === "ArrowRight") {
                  target = tabs[(index + 1) % tabs.length];
                } else if (event.key === "ArrowLeft") {
                  target = tabs[(index - 1 + tabs.length) % tabs.length];
                } else if (event.key === "Home") {
                  target = tabs[0];
                } else if (event.key === "End") {
                  target = tabs[tabs.length - 1];
                } else if (event.key === "Enter" || event.key === " ") {
                  target = id;
                }
                if (target !== undefined) {
                  event.preventDefault();
                  focusAndActivate(target);
                }
              }}
              title={t("tabTooltip", { title, dirty })}
            >
              {dirty && <span className="tab-dirty" aria-hidden="true" />}
              <span className="tab-title">{title}</span>
            </button>
            <button
              className="tab-close"
              type="button"
              aria-label={t("closeTab", { title })}
              title={t("closeTab", { title })}
              onClick={(e) => {
                e.stopPropagation();
                void closeTabWithConfirm(id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        className="tab-add"
        type="button"
        aria-label={t("newTab")}
        title={t("newTab")}
        onClick={() => openTab()}
      >
        +
      </button>
    </div>
  );
}
