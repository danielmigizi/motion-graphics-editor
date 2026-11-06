// What a locked tab and Settings › Open in another tab or browser say.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PermissionDetail } from './PermissionPrompt';
import { OtherBrowserSetting } from './SettingsDialog';
import { LockedNoticeText } from './TopBar';

const notice = (props: { linkFile?: string | null; code?: string | null; error?: string | null }) =>
  renderToStaticMarkup(createElement(LockedNoticeText, { linkFile: null, code: null, error: null, ...props }))
    // Text only: the copy as a person reads it.
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'");

describe('the locked notice', () => {
  it('points at the terminal when the link was printed there', () => {
    const text = notice({});
    expect(text).toContain('Open the editor link from the terminal where npm run dev is running.');
    expect(text).not.toContain('An agent started the editor');
  });

  it('points at the file when an agent started the editor', () => {
    const text = notice({ linkFile: '/home/u/.config/mge/editor-link' });
    expect(text).toContain(
      'An agent started the editor, so its link wasn’t printed in a terminal. It’s saved in /home/u/.config/mge/editor-link: open that file from your own terminal (for example cat /home/u/.config/mge/editor-link) and paste the link here. It works once.',
    );
    expect(text).not.toContain('npm run dev');
  });

  it('while a minted link waits, names the code to compare instead of the last error', () => {
    const waiting = notice({ code: 'K7Q-2MX', error: 'An old reason.' });
    expect(waiting).toContain('Waiting for the unlocked tab. It will ask you to allow this browser: allow it only if it shows the code K7Q-2MX.');
    expect(waiting).not.toContain('An old reason.');
    expect(notice({ error: 'An old reason.' })).toContain('An old reason.');
  });

  it('sets the code apart in the pairing-code style', () => {
    const html = renderToStaticMarkup(createElement(LockedNoticeText, { linkFile: null, code: 'K7Q-2MX', error: null }));
    expect(html).toContain('<strong class="pairing-code" data-testid="session-code">K7Q-2MX</strong>');
  });
});

describe('the unlocked tab’s card for another browser', () => {
  const detail = (text: string) => renderToStaticMarkup(createElement(PermissionDetail, { detail: text }));

  it('shows the code in the same pairing-code style, the server’s sentence unchanged around it', () => {
    const html = detail('Code K7Q-2MX. Allow only if the other tab shows this code.');
    expect(html).toContain('<strong class="pairing-code" data-testid="permission-code">K7Q-2MX</strong>');
    expect(html.replace(/<[^>]+>/g, '')).toBe('Code K7Q-2MX. Allow only if the other tab shows this code.');
  });

  it('leaves any other detail as plain text', () => {
    expect(detail('rm -rf build')).toBe('<p class="permission-detail">rm -rf build</p>');
    expect(detail('Codex wants to read a file.')).not.toContain('pairing-code');
  });
});

describe('Settings › Open in another tab or browser', () => {
  it('offers a new unlocked tab and a one-time link, each with its own note', () => {
    const html = renderToStaticMarkup(createElement(OtherBrowserSetting));
    expect(html).toContain('New tab');
    expect(html).toContain('Open a new unlocked tab');
    expect(html).toContain('Another browser');
    expect(html).toContain('Copy a one-time link');
    expect(html).toContain('Each link works once, for 5 minutes. When it’s opened, this tab asks you to allow it. Links stop working when the server restarts.');
  });
});
