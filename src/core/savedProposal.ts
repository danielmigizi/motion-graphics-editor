import type { Proposal } from './proposal';
import { validatePatch } from './patch';
import type { CommandError } from './types';

/** Validate metadata as well as the patch before storing or restoring it. */
export function validateProposal(value: unknown, projectId: string):
  { ok: true; proposal: Proposal } | { ok: false; error: CommandError } {
  const p = value as Partial<Proposal> | null;
  if (!p || typeof p !== 'object' || Array.isArray(p) ||
    typeof p.id !== 'string' || !p.id.trim() || typeof p.docSession !== 'string' || !p.docSession.trim() ||
    typeof p.agent !== 'string' || !p.agent.trim() ||
    (p.model !== undefined && typeof p.model !== 'string') ||
    !['chat', 'mcp', 'paste'].includes(p.source ?? '') || typeof p.reconcile !== 'boolean' ||
    typeof p.createdAt !== 'number' || !Number.isFinite(p.createdAt) || p.createdAt < 0) {
    return { ok: false, error: { code: 'INVALID', message: 'Body must contain a valid Proposal.' } };
  }
  const patch = validatePatch(p.patch);
  if (!patch.ok) return patch;
  if (p.projectId !== projectId || patch.patch.projectId !== projectId) {
    return { ok: false, error: { code: 'PROJECT_MISMATCH', message: 'Proposal and patch projectId must match the URL project id.' } };
  }
  return { ok: true, proposal: {
    id: p.id, projectId, docSession: p.docSession, patch: patch.patch, agent: p.agent,
    ...(p.model !== undefined ? { model: p.model } : {}), source: p.source!, reconcile: p.reconcile, createdAt: p.createdAt,
  } };
}
