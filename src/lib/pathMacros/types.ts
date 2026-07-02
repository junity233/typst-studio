export interface MacroContext {
  workspace?: string;
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
