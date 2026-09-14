// A DEPOSIT ARRIVES WHEREVER THE READER IS.
//
// Mounted at the application, not inside the library — the same place `DroppedProfile` sits, and for
// the same reason: a file can be dropped while a book is open, and a sheet that only exists on the
// library surface would leave that drop doing nothing at all. Measured: it did.
//
// It renders nothing until a deposit is offered, so it costs a subscription and no markup.
import { DepositReceive } from "./DepositReceive";
import { useIncomingDeposit } from "./store";

export function DroppedDeposit() {
  const path = useIncomingDeposit((s) => s.path);
  const clear = useIncomingDeposit((s) => s.clear);
  // A DEPOSIT OF ONE'S OWN COMES FIRST. While the sending sheet is open the offer is held, not refused:
  // the path is already recorded, and closing that sheet is what lets this one through. Two sheets are
  // never on screen at once, and an inscription in progress is never buried under a second question.
  const composing = useIncomingDeposit((s) => s.composing);
  if (!path || composing) return null;
  return <DepositReceive path={path} onClose={clear} />;
}
