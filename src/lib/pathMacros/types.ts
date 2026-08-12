export interface MacroContext {
  workspace?: string;
  /** Project title (from `.typstpro` `title`) — the `${title}` macro source. */
  title?: string;
  fileDir?: string;
  fileName?: string;
  filePath?: string;
  hash?: string;
  ext?: string;
  timestamp?: string;
  index?: number;
}

export interface ExpandOptions {
  unknown?: "keep" | "drop" | "throw";
}
