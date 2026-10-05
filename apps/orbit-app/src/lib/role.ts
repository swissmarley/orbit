import { type PrincipalRole, roleAtLeast } from '@orbit/core/browser';
import { type RouteName, roleFor } from '@orbit/sdk-client/browser';
import { useSession } from './queries';

/**
 * "Always allow" is an approve with `always: true`: the route needs an
 * operator, but orbitd grants standing permission to the owner only
 * (packages/api/src/app.ts, the approve handler). Mirrored here, in one place.
 */
export const ALWAYS_ALLOW_ROLE: PrincipalRole = 'owner';

/** Why a control is unavailable to this principal, in words. */
export function needsRoleText(role: PrincipalRole): string {
  return `Needs the ${role} role`;
}

export interface RoleCheck {
  /** The signed-in principal's role (the bearer token and a local App session are the owner). */
  role: PrincipalRole;
  /** May this principal use `route`? (the contract's role table, ADR-015) */
  can: (route: RouteName) => boolean;
  atLeast: (needed: PrincipalRole) => boolean;
}

export function roleCheck(role: PrincipalRole): RoleCheck {
  return {
    role,
    can: (route) => roleAtLeast(role, roleFor(route)),
    atLeast: (needed) => roleAtLeast(role, needed),
  };
}

/**
 * The signed-in principal's role, for disabling what it cannot use. The App
 * shell renders screens only once the session is known; before that (and in
 * stories without a session) it is the owner, as in local mode. orbitd
 * refuses what a role may not do either way: this only keeps the UI honest.
 */
export function useRole(): RoleCheck {
  const session = useSession();
  return roleCheck(session.data?.principal.role ?? 'owner');
}
