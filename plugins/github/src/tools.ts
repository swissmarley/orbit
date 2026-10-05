import { gitTools } from './git';
import { githubTools } from './github';

export * from './git';
export * from './github';

/** Every tool the server offers; orbit-plugin.json declares exactly these, in this order. */
export const tools = [...githubTools, ...gitTools];
