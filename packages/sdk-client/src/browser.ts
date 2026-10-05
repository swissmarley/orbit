/**
 * @orbit/sdk-client/browser — the typed client and SSE stream without local
 * daemon discovery (which reads $ORBIT_HOME with node:fs). The App imports
 * only this entry; a guard test keeps it free of Node built-ins.
 */
export * from './client';
export type {
  Approval,
  DoctorReport,
  ErrorBody,
  RouteBody,
  RouteName,
  RouteQuery,
  RouteResponse,
} from '@orbit/api/contract';
export { CSRF_HEADER } from '@orbit/api/contract';
