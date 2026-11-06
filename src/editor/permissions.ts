// Provider-neutral user decisions: the editor's own destructive actions ask
// through MCP, and Claude Code, Codex (App Server) and Cursor (ACP) forward
// their native permission requests here while Auto-apply is off. When the
// agent stops waiting (Stop, a project switch, its turn ending), the server
// cancels the request and the card goes away (cancelPermission).
import { create } from 'zustand';
import { permissionTimeoutMs, type BridgeCommand, type BridgeReply } from '../core/api-contract';

type Request = Extract<BridgeCommand, { type: 'askPermission' }>;
type Decision = 'allowed' | 'denied' | 'timeout';
interface PermissionState {
  pending: (Request & { expiresAt: number }) | null;
  decide: (decision: Decision) => void;
}
let settle: ((reply: BridgeReply) => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export const usePermissions = create<PermissionState>(() => ({
  pending: null,
  decide: (message) => {
    if (!settle) return;
    const resolve = settle;
    settle = null;
    if (timer) clearTimeout(timer);
    timer = null;
    const expired = Date.now() >= (usePermissions.getState().pending?.expiresAt ?? Infinity);
    usePermissions.setState({ pending: null });
    resolve({ ok: true, message: expired ? 'timeout' : message });
  },
}));

/** The agent stopped waiting for `requestId`: dismiss its card (denied). Another request's card stays. */
export function cancelPermission(requestId: string) {
  if (!settle || usePermissions.getState().pending?.requestId !== requestId) return;
  const resolve = settle;
  settle = null;
  if (timer) clearTimeout(timer);
  timer = null;
  usePermissions.setState({ pending: null });
  resolve({ ok: true, message: 'denied', reason: 'cancelled' });
}

export function askPermission(request: Request): Promise<BridgeReply> {
  if (settle) return Promise.resolve({ ok: true, message: 'denied', reason: 'another request is waiting' });
  return new Promise((resolve) => {
    const timeoutMs = permissionTimeoutMs(request.timeoutMs);
    settle = resolve;
    timer = setTimeout(() => usePermissions.getState().decide('timeout'), timeoutMs);
    usePermissions.setState({ pending: { ...request, expiresAt: Date.now() + timeoutMs } });
  });
}
