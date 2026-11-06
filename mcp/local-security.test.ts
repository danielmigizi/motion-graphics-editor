import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalEditor } from './local';
import { createHandlers } from './tools';
import { PRIVATE_FILE_MESSAGE } from '../server/local-file';
import { redactEditorSecrets, requiredBridgeToolsPresent } from '../scripts/bridge-verification';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mge-mcp-private-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
it('delegates caller paths to the server without reading them in the MCP environment', async () => {
  const config = join(root, 'private'); await mkdir(config);
  const secret = join(config, 'key.png'); await writeFile(secret, 'secret');
  const alias = join(root, 'innocent.png'); await symlink(secret, alias);
  // MCP deliberately lacks the server's config-dir environment.
  vi.stubEnv('MGE_CONFIG_DIR', join(root, 'other-config'));
  const local = new LocalEditor({ rootDir: root, serverPort: 5918, webPort: 5917, openBrowser: false });
  vi.spyOn(local, 'state').mockRejectedValue(new Error('no editor'));
  const request = vi.spyOn(local, 'request').mockRejectedValue(new Error(PRIVATE_FILE_MESSAGE));
  const result = await createHandlers(local).editor_import_asset({ path: alias });
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: 'text', text: PRIVATE_FILE_MESSAGE }]);
  expect(request).toHaveBeenCalledExactlyOnceWith('POST', '/api/assets/import-local', { path: alias, name: undefined });
});
it('redacts session and tab query secrets before log text is truncated', () => {
  const text = 'GET http://localhost:5318/api/editor/events?tab=secret_tab&other=ok session http://localhost:5317/?session=secret_link#fragment';
  const redacted = redactEditorSecrets(text);
  expect(redacted).not.toContain('secret_tab'); expect(redacted).not.toContain('secret_link');
  expect(redacted).toContain('other=ok');
  expect(redactEditorSecrets('tab=bare_secret session=bare_link')).toBe('tab=[redacted] session=[redacted]');
});
it('checks required tools while allowing additions and refusing missing tools', () => {
  const tools = ['editor_open', 'editor_get_context', 'editor_write_project', 'editor_apply_patch', 'editor_focus', 'editor_render_frame', 'editor_build_template', 'editor_build_motion', 'editor_save'];
  expect(requiredBridgeToolsPresent([...tools, 'new_tool'])).toBe(true);
  expect(requiredBridgeToolsPresent(tools.slice(1))).toBe(false);
});
