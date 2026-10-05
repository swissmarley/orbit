/**
 * Is a modal dialog open (an approval card, a confirmation, the palette)?
 * Global shortcuts (Ctrl/⌘+K, ?) never open on top of one: they would steal
 * focus from a decision in progress.
 */
export function otherModalOpen(doc: Document = document): boolean {
  return (
    doc.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    ) !== null
  );
}
