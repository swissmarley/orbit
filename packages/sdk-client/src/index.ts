/**
 * @orbit/sdk-client — typed client for the orbitd API (derived from the
 * shared zod contract), SSE event stream with reconnect and Last-Event-ID
 * resume, and local daemon discovery ($ORBIT_HOME/daemon.json + token).
 */
export * from './client';
export * from './local';
