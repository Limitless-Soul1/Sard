// The app-level host for a dropped profile package.
//
// Renders nothing until a drop has been inspected and accepted by the Rust gate. It exists so the
// drop and the file picker end in the SAME sheet, with the same validation and the same commit —
// there is one import pipeline, and this is not a second entrance to it.
//
// IT HOSTS THE EDITOR TOO, and it has to. The sheet's last frame offers «تعديل» on the profile that
// just arrived, and an offer is only as real as the thing mounted to receive it: the Settings copy
// hands that job to `ProfilesSection`'s own dialog state, which a DROP never passes through. Here
// `onEdit` was wired to the same `clear` as `onClose`, so choosing «تعديل» dismissed the sheet and
// opened nothing — the offer looked like a dead button because, on this path, it was one.
import { useState } from "react";

import { ImportSheet } from "./ImportSheet";
import { ProfileEditor } from "./ProfileEditor";
import { useDropped } from "./dropped";
import type { Profile } from "./model/profile";

export function DroppedProfile() {
  const text = useDropped((s) => s.text);
  const path = useDropped((s) => s.path);
  const clear = useDropped((s) => s.clear);
  const [editing, setEditing] = useState<Profile | null>(null);

  // ASKED FIRST, because the sheet closes itself on the way here: `onEdit` runs beside its own
  // `onClose`, so `text` is already null by the time the editor is wanted. Reading `editing` after
  // that guard would return null and throw the request away.
  if (editing) return <ProfileEditor profile={editing} onClose={() => setEditing(null)} />;
  if (!text) return null;
  return <ImportSheet initialText={text} initialPath={path} onClose={clear} onEdit={setEditing} />;
}
