import { h, btn } from './ui.js';

/**
 * Touch/mouse/pen signature pad. Returns { el, isEmpty(), toDataURL(), clear() }.
 * Strokes are kept as point lists so the drawing survives a resize.
 */
export function signaturePad({ onChange } = {}) {
  const canvas = h('canvas', { 'aria-label': 'Signature area — sign with your finger or mouse' });
  const wrap = h('div', { class: 'sigpad' },
    h('div', { class: 'sig-placeholder' }, 'Sign here'),
    h('div', { class: 'sig-line' }),
    h('div', { class: 'sig-x' }, '×'),
    canvas);
  const strokes = [];
  let current = null;
  let ratio = 1;
  let cssWidth = 0;

  const ctx = canvas.getContext('2d');
  const setup = () => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || rect.width === cssWidth) return;
    cssWidth = rect.width;
    ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    redraw();
  };
  const redraw = () => {
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1e2952';
    for (const stroke of strokes) drawStroke(stroke);
  };
  const drawStroke = (pts) => {
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x * cssWidth, pts[0].y, 1.4, 0, Math.PI * 2);
      ctx.fillStyle = '#1e2952';
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x * cssWidth, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const midX = ((pts[i].x + pts[i + 1].x) / 2) * cssWidth;
      const midY = (pts[i].y + pts[i + 1].y) / 2;
      ctx.lineWidth = pts[i].w;
      ctx.quadraticCurveTo(pts[i].x * cssWidth, pts[i].y, midX, midY);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x * cssWidth, last.y);
    ctx.stroke();
  };
  const point = (e) => {
    const rect = canvas.getBoundingClientRect();
    const pressure = e.pressure && e.pointerType === 'pen' ? e.pressure : 0.5;
    return { x: (e.clientX - rect.left) / rect.width, y: e.clientY - rect.top, w: 1.6 + pressure * 2 };
  };

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    setup();
    canvas.setPointerCapture(e.pointerId);
    current = [point(e)];
    strokes.push(current);
    wrap.classList.add('signed');
    redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    e.preventDefault();
    current.push(point(e));
    redraw();
  });
  const end = () => {
    if (!current) return;
    current = null;
    onChange?.();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  const observer = new ResizeObserver(() => setup());
  observer.observe(canvas);

  const api = {
    el: h('div', { class: 'stack-sm' }, wrap,
      h('div', { class: 'row' }, h('span', { class: 'small muted spacer' }, 'Use your finger, a stylus or the mouse.'),
        btn('Clear', { size: 'sm', variant: 'ghost', iconName: 'x', onClick: () => api.clear() }))),
    isEmpty: () => strokes.reduce((n, s) => n + s.length, 0) < 6,
    toDataURL: () => canvas.toDataURL('image/png'),
    clear() {
      strokes.length = 0;
      wrap.classList.remove('signed');
      redraw();
      onChange?.();
    },
  };
  return api;
}
