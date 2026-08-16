// The app-level host for a dropped profile package.
//
// Renders nothing until a drop has been inspected and accepted by the Rust gate. It exists so the
// drop and the file picker end in the SAME sheet, with the same validation and the same commit —
// there is one import pipeline, and this is not a second entrance to it.
import { ImportSheet } from "./ImportSheet";
import { useDropped } from "./dropped";

export function DroppedProfile() {
  const text = useDropped((s) => s.text);
  const clear = useDropped((s) => s.clear);
  if (!text) return null;
  return <ImportSheet initialText={text} onClose={clear} onEdit={clear} />;
}
