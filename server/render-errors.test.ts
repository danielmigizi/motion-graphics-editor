import { describe, expect, it } from 'vitest';
import { describeRenderError } from './render-errors';

describe('describeRenderError', () => {
  it('names the likely cause of the native engine’s failures', () => {
    expect(describeRenderError(new Error('Timed out after 60s waiting for: Loading image /assets/a.png'))).toMatch(/took too long to load/);
    expect(describeRenderError(new Error('Image failed to load: http://localhost:5318/assets/x.png'))).toMatch(/could not be loaded/);
    expect(describeRenderError(new Error('No decoded frames for http://localhost:5318/v.mp4; the exporter did not prepare this video.'))).toMatch(/could not be decoded/);
    expect(describeRenderError(new Error('browserType.launch: Executable doesn’t exist'))).toMatch(/headless Chrome/);
    expect(describeRenderError(new Error('ffmpeg exited with 1: Invalid argument'))).toMatch(/encoding failed/);
  });

  it('keeps the font gate’s own message and shortens long ones', () => {
    expect(describeRenderError(new Error('Bundled fonts failed to load: Inter 700. The render was stopped'))).toBe('Bundled fonts failed to load: Inter 700. The render was stopped');
    expect(describeRenderError(new Error('x'.repeat(400)))).toMatch(/^x{237}\.\.\.($| — )/);
  });
});
