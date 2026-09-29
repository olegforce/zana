// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReleaseNoteVideo } from './ReleaseNoteVideo.js';

afterEach(cleanup);

describe('ReleaseNoteVideo', () => {
  it('offers the bundled walkthrough without autoplay or a network dependency', () => {
    render(<ReleaseNoteVideo version="2.3.0" />);
    const video = screen.getByLabelText('Use Zana everywhere walkthrough') as HTMLVideoElement;
    expect(video.controls).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.autoplay).toBe(false);
    expect(video.preload).toBe('none');
    expect(video.getAttribute('poster')).toMatch(/zana-everywhere\.jpg/);
    expect(video.querySelector('source')?.getAttribute('src')).toMatch(/zana-everywhere\.mp4/);
    expect(video.querySelector('source')?.getAttribute('type')).toBe('video/mp4');
    for (const url of [video.poster, video.querySelector('source')!.src, video.querySelector('track')!.src]) {
      expect(new URL(url).origin).toBe(window.location.origin);
    }
    const captions = video.querySelector('track')!;
    expect(captions.kind).toBe('captions');
    expect(captions.srclang).toBe('en');
    expect(captions.label).toBe('English');
    expect(captions.getAttribute('src')).toMatch(/zana-everywhere\.en\.vtt/);
    expect(screen.getByRole('link', { name: 'Save video' }).getAttribute('href'))
      .toBe(video.querySelector('source')!.getAttribute('src'));
  });

  it.each(['2.2.0', '2.3.1', '', 'https://untrusted.example/video.mp4'])('does not invent media for %s', (version) => {
    const { container } = render(<ReleaseNoteVideo version={version} />);
    expect(container.innerHTML).toBe('');
  });
});
