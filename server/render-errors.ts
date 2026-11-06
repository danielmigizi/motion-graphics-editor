// Render failures in one line a person can act on: the first meaningful line
// of the error plus its likely cause.

export function describeRenderError(err: unknown): string {
  const raw = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  const first =
    (err instanceof Error ? err.message : String(err))
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? 'Unknown render error';
  const short = first.length > 240 ? `${first.slice(0, 237)}...` : first;
  // The composition's own font gate already explains itself.
  if (/^Bundled fonts failed to load/.test(first)) return short;
  const causes: [RegExp, string][] = [
    [/\btimed out\b|\btimeout\b/i, 'an asset, font or media file took too long to load; check the asset paths and that the local server is reachable'],
    [/Image failed to load|404|ERR_|ECONNREFUSED|Failed to (load|fetch)|net::/i, 'an asset could not be loaded from the local server; check that the file exists under public/'],
    [/No decoded frames|has no video stream|decoded no frames/i, 'a video file could not be decoded; check that it plays and re-import it'],
    [/Could not resolve|Build failed|SyntaxError|\[vite\]|rolldown/i, 'the render page failed to build; check the composition code for syntax errors'],
    [/browser|chrom|executable|Target closed|Protocol error/i, 'headless Chrome failed to start or crashed; try again, install one (npx playwright-core install chromium-headless-shell) or set MGE_BROWSER_EXECUTABLE'],
    [/ffmpeg|encod/i, 'video encoding failed'],
    [/ENOSPC/i, 'the disk is full'],
    [/cancel|abort/i, 'the render was cancelled'],
  ];
  // The message decides when it can; the stack only as a fallback.
  const cause = (causes.find(([re]) => re.test(first)) ?? causes.find(([re]) => re.test(raw)))?.[1];
  return cause ? `${short} — likely cause: ${cause}` : short;
}
