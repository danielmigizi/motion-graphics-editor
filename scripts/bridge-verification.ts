/** Redact URL query secrets even when URLs appear inside console/error text. */
export function redactEditorSecrets(text: string): string {
  return text.replace(/(\b(?:tab|session)=)[^&#\s"'<>]*/gi, '$1[redacted]');
}
const REQUIRED_TOOLS = ['editor_open', 'editor_get_context', 'editor_write_project', 'editor_apply_patch', 'editor_focus', 'editor_render_frame', 'editor_build_template', 'editor_build_motion', 'editor_save'];
export function requiredBridgeToolsPresent(tools: readonly string[]): boolean {
  return REQUIRED_TOOLS.every(name => tools.includes(name));
}
