import { AlertTriangle } from "lucide-react";
import i18n from "../../i18n";

/**
 * Shared error / loading placeholder for the binary viewers (image, pdf):
 * a full-pane warning with the message on error, a plain loading pane while
 * the bytes are being fetched. `errorClassName` picks the viewer-specific
 * error styling (`image-viewer-error` / `pdf-viewer-error`).
 */
export function ViewerStatus({
  error,
  errorClassName,
}: {
  error: string | null;
  errorClassName: string;
}): React.JSX.Element {
  if (error !== null) {
    return (
      <div className={`pane pane-empty ${errorClassName}`}>
        <AlertTriangle size={28} />
        <p>
          {i18n.t("couldNotOpen", {
            ns: "errors",
            message: error,
          })}
        </p>
      </div>
    );
  }
  return <div className="pane pane-empty">{i18n.t("loading", { ns: "preview" })}</div>;
}
