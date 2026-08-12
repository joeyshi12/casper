type Sender = (text: string) => void;

let sender: Sender | null = null;

/** Registered by the Shell, which owns the socket. */
export function setPromptSender(fn: Sender | null): void {
  sender = fn;
}

/** A widget asking to send a message as the user. Capped, and a no-op if nothing
 *  is listening, so a stale frame can't send into the void. */
export function sendWidgetPrompt(text: string): boolean {
  const clean = text.trim().slice(0, 4000);
  if (!clean || !sender) return false;
  sender(clean);
  return true;
}
