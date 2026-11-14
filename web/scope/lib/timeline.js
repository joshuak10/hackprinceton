// Timeline: incident histogram behind a real range input, play/pause and speed.
import { clockText } from './frames.js';

const CATS = ['decision', 'congestion', 'complaint'];

export function createTimeline({ root, onSeek, onPlay, onSpeed }) {
  const hist = root.querySelector('#hist');
  const scrub = root.querySelector('#scrub');
  const playBtn = root.querySelector('#playBtn');
  const playIcon = root.querySelector('#playIcon');
  const clock = root.querySelector('#clock');
  const span = root.querySelector('#span');
  const T = { duration: 1, clockStart: 0, bins: [], pal: null };

  scrub.addEventListener('input', () => onSeek(Number(scrub.value), { user: true }));
  playBtn.addEventListener('click', () => onPlay());
  root.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => onSpeed(Number(b.dataset.speed))));

  T.setRun = ({ duration, clockStart, bins, pal }) => {
    Object.assign(T, { duration, clockStart, bins, pal });
    scrub.max = String(duration);
    scrub.step = String(1 / 60);
    span.textContent = `${clockText(clockStart, 0)} to ${clockText(clockStart, duration)}`;
    T.layout();
  };

  T.layout = () => {
    const r = hist.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    hist.width = Math.round(r.width * dpr);
    hist.height = Math.round(r.height * dpr);
    T.dpr = dpr; T.w = r.width; T.h = r.height;
    draw(T.lastT ?? 0);
  };

  T.update = (t, playing) => {
    T.lastT = t;
    scrub.value = String(t);
    const c = clockText(T.clockStart, t);
    clock.textContent = c;
    scrub.setAttribute('aria-valuetext', c);
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playIcon.setAttribute('d', playing ? 'M5 4h3.6v12H5zM11.4 4H15v12h-3.6z' : 'M6 4l10 6-10 6z');
    draw(t);
  };

  function draw(t) {
    const g = hist.getContext('2d');
    const pal = T.pal;
    if (!pal || !T.w) return;
    g.setTransform(T.dpr, 0, 0, T.dpr, 0, 0);
    g.clearRect(0, 0, T.w, T.h);
    const n = T.bins.length;
    const thumb = 9;
    const x0 = thumb, x1 = T.w - thumb, bw = (x1 - x0) / Math.max(1, n);
    const max = Math.max(4, ...T.bins.map(b => b.total));
    const H = T.h - 4;
    // Baseline
    g.fillStyle = pal['line-2'];
    g.fillRect(x0, T.h - 1, x1 - x0, 1);
    T.bins.forEach((b, i) => {
      let y = T.h - 1;
      const past = i + 1 <= t;
      for (const cat of CATS) {
        const v = b[cat] || 0;
        if (!v) continue;
        const h = (v / max) * H;
        g.globalAlpha = past ? 1 : 0.28;
        g.fillStyle = pal['i-' + cat];
        g.fillRect(x0 + i * bw + 0.5, y - h, Math.max(1, bw - 1), h);
        y -= h;
      }
    });
    g.globalAlpha = 1;
    // Playhead
    const px = x0 + (t / T.duration) * (x1 - x0);
    g.fillStyle = pal.text;
    g.fillRect(Math.round(px) - 1, 0, 2, T.h);
  }

  return T;
}
