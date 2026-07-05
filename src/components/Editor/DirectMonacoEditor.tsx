import { useEffect, useRef, type CSSProperties } from "react";
import * as Monaco from "@codingame/monaco-vscode-editor-api";
import { Uri } from "vscode";
import type { TextContents } from "monaco-languageclient/editorApp";

interface DirectMonacoEditorProps {
  style?: CSSProperties;
  className?: string;
  editorOptions?: Monaco.editor.IStandaloneEditorConstructionOptions;
  onTextChanged?: (textChanges: TextContents) => void;
  onEditorStartDone?: (editor: Monaco.editor.IStandaloneCodeEditor) => void;
  onError?: (error: Error) => void;
  onDisposeEditor?: () => void;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

export function DirectMonacoEditor({
  style,
  className,
  editorOptions,
  onTextChanged,
  onEditorStartDone,
  onError,
  onDisposeEditor,
}: DirectMonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const onTextChangedRef = useRef(onTextChanged);
  const onEditorStartDoneRef = useRef(onEditorStartDone);
  const onErrorRef = useRef(onError);
  const onDisposeEditorRef = useRef(onDisposeEditor);
  onTextChangedRef.current = onTextChanged;
  onEditorStartDoneRef.current = onEditorStartDone;
  onErrorRef.current = onError;
  onDisposeEditorRef.current = onDisposeEditor;

  useEffect(() => {
    if (!containerRef.current) return;

    let contentListener: Monaco.IDisposable | null = null;
    let bootstrapModel: Monaco.editor.ITextModel | null = null;

    try {
      bootstrapModel = Monaco.editor.createModel(
        "",
        "typst",
        Uri.parse(`inmemory://typst-studio/bootstrap-${Date.now()}.typ`),
      );
      const editor = Monaco.editor.create(containerRef.current, {
        ...editorOptions,
        model: bootstrapModel,
      });
      editorRef.current = editor;
      contentListener = editor.onDidChangeModelContent(() => {
        const model = editor.getModel();
        onTextChangedRef.current?.({ modified: model?.getValue() ?? "" });
      });
      // Dispose the throwaway bootstrap model once the registry swaps in a real
      // model via editor.setModel(...). The bootstrap is `inmemory://`-scheme
      // so it's invisible to the LSP documentSelector and the model registry,
      // but we still don't want a detached empty model lingering in
      // monaco.editor.getModels() for the editor's lifetime.
      let bootstrapDisposed = false;
      const modelListener = editor.onDidChangeModel((e) => {
        if (
          !bootstrapDisposed &&
          e.newModelUrl?.toString() !== bootstrapModel?.uri.toString()
        ) {
          bootstrapDisposed = true;
          bootstrapModel?.dispose();
          bootstrapModel = null;
          modelListener.dispose();
        }
      });
      onEditorStartDoneRef.current?.(editor);
    } catch (error) {
      onErrorRef.current?.(normalizeError(error));
    }

    return () => {
      contentListener?.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
      bootstrapModel?.dispose();
      onDisposeEditorRef.current?.();
    };
  }, []);

  useEffect(() => {
    if (editorOptions) {
      editorRef.current?.updateOptions(editorOptions);
    }
  }, [editorOptions]);

  return <div ref={containerRef} style={style} className={className} />;
}
