import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('copyText', () => {
  it('copies the exact message text including lines and emoji', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('window', { isSecureContext: true });

    await expect(copyText('First line\nSecond line 😀')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('First line\nSecond line 😀');
  });

  it('reports failure instead of throwing', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard unavailable'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('window', { isSecureContext: true });

    await expect(copyText('Message')).resolves.toBe(false);
  });
});
