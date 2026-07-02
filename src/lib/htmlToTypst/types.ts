export interface ConvertContext {
  workspace?: string;
  filePath?: string;
  imageTemplate: string;
  fetchRemote: boolean;
}

export interface PendingImage {
  placeholder: string;
  src: string;
  alt?: string;
  index: number;
}

export interface ConvertResult {
  typst: string;
  pendingImages: PendingImage[];
  warnings: string[];
}

/** 内部：递归转换上下文（带图片计数器，可变收集）。 */
export interface WalkCtx {
  convert: ConvertContext;
  pendingImages: PendingImage[];
  warnings: string[];
  nextImageIndex: number;
}

export function makeWalkCtx(convert: ConvertContext): WalkCtx {
  return { convert, pendingImages: [], warnings: [], nextImageIndex: 0 };
}
