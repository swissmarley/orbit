/**
 * Inbound content reaches a Run inside `<orbit-untrusted>` tags (ADR-014).
 * The format lives in @orbit/core, so clients can split a trigger's prompt
 * back into the task and the delivered data (ADR-020).
 */
export { MAX_UNTRUSTED_CHARS, triggerPrompt, untrustedBlock } from '@orbit/core';
