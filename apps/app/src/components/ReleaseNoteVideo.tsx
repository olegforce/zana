import videoUrl from '../assets/release-notes/zana-everywhere.mp4?url&no-inline';
import posterUrl from '../assets/release-notes/zana-everywhere.jpg?url&no-inline';
import captionsUrl from '../assets/release-notes/zana-everywhere.en.vtt?url&no-inline';
import './ReleaseNoteVideo.css';

/** Curated, bundled media only: release Markdown cannot supply a video URL. */
export function ReleaseNoteVideo({ version }: { version: string }) {
  if (version !== '2.3.0') return null;

  return (
    <figure className="release-note-video">
      <figcaption>
        <h2>Use Zana everywhere</h2>
        <p>Connect your desktop, then open your Zana address in Safari on your iPhone.</p>
      </figcaption>
      <video aria-label="Use Zana everywhere walkthrough" controls playsInline preload="none" poster={posterUrl}>
        <source src={videoUrl} type="video/mp4" />
        <track kind="captions" src={captionsUrl} srcLang="en" label="English" />
        Your browser does not support video playback.
      </video>
      <div className="release-note-video-details">
        <span>64 seconds · English voiceover and captions</span>
        <a href={videoUrl} download="zana-everywhere.mp4">Save video</a>
      </div>
    </figure>
  );
}
