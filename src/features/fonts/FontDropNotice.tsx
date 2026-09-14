// THE ANSWER A DROPPED FONT GETS.
//
// Sard's own toast — the one a saved هيئة uses (`.pf-toast`): same shape, same place at the foot of
// the window, so the answer to a drop arrives where the reader already looks for one. It is
// deliberately not a dialog: a successful import asks nothing and a refusal asks nothing either, and
// interrupting a reader to say "that worked" is the thing this pattern exists to avoid.
//
// It fades on its own, like every other Sard confirmation. A refusal is given longer, because it is
// the one the reader may need to read twice.
import { useEffect } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import { useFontDrop } from "./dropped";

export function FontDropNotice() {
  const notice = useFontDrop((s) => s.notice);
  const clear = useFontDrop((s) => s.clear);
  const { t } = useI18n();

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(clear, notice.bad ? 7000 : 4500);
    return () => window.clearTimeout(id);
    // Re-armed per announcement: `at` changes even when the same message repeats, so a second drop
    // restarts the window instead of inheriting the remains of the first one's.
  }, [notice, clear]);

  if (!notice) return null;
  return createPortal(
    <div className="pf-toast" role="status">
      <span className="pf-toast-msg">
        {notice.name ? t(notice.key, { name: notice.name }) : t(notice.key)}
      </span>
    </div>,
    document.body,
  );
}
