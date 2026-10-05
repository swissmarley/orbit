/** @jsxRuntime automatic @jsxImportSource react */
import type { PrincipalRole } from '@orbit/core/browser';
import { type RouteName, roleFor } from '@orbit/sdk-client/browser';
import { type MouseEvent, type ReactElement, type ReactNode, Children, cloneElement } from 'react';
import { needsRoleText, useRole } from '../lib/role';
import { Tooltip } from './ui/tooltip';

interface GateProps {
  /** The route the control calls (its role comes from the contract)… */
  route?: RouteName;
  /** …or the role it needs, when it is not one route. */
  role?: PrincipalRole;
}

function neededRole({ route, role }: GateProps): PrincipalRole {
  if (role) return role;
  if (route) return roleFor(route);
  return 'viewer';
}

/**
 * A button the signed-in principal may lack the role for (hosted mode,
 * ADR-015). Allowed: the button as it is. Otherwise it stays focusable but
 * inert (`aria-disabled`), says why in a tooltip and in its accessible name,
 * and swallows clicks (also those an `asChild` trigger would act on).
 */
export function RoleGate(
  props: GateProps & {
    children: ReactElement;
    /** A tooltip for those who may use the control (the role reason replaces it otherwise). */
    hint?: ReactNode;
  },
) {
  const check = useRole();
  const needed = neededRole(props);
  if (check.atLeast(needed)) {
    return props.hint ? <Tooltip content={props.hint}>{props.children}</Tooltip> : props.children;
  }
  const child = props.children as ReactElement<{
    children?: ReactNode;
    'aria-label'?: string;
  }>;
  const reason = needsRoleText(needed);
  const label = child.props['aria-label'];
  const inert = cloneElement(
    child,
    {
      'aria-disabled': true,
      onClick: (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
      },
      'data-needs-role': needed,
      ...(label ? { 'aria-label': `${label} (${reason.toLowerCase()})` } : {}),
    } as Record<string, unknown>,
    ...Children.toArray(child.props.children),
    <span key="needs-role" className="sr-only">
      {` (${reason.toLowerCase()})`}
    </span>,
  );
  return <Tooltip content={reason}>{inert}</Tooltip>;
}

/** Content shown only to principals with the role (a control that would only confuse others). */
export function IfRole(props: GateProps & { children: ReactNode }) {
  const check = useRole();
  return check.atLeast(neededRole(props)) ? props.children : null;
}
