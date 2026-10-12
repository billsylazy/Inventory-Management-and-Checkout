import { h, btn, icon, toast } from './ui.js';

/** Shrinks a photo in the browser so uploads stay small on school Wi-Fi. */
export async function compressImage(file, { maxSize = 1280, quality = 0.82 } = {}) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That file is not an image we can read'));
      img.src = URL.createObjectURL(file);
    });
  }
  const scale = Math.min(1, maxSize / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * "Take/choose photo" button with a preview. On phones the file picker offers
 * the rear camera directly.
 */
export function photoPicker({ label = 'Add photo', onChange, maxSize, emphasize = false } = {}) {
  let value = null;
  const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const preview = h('div', { class: 'photo-preview', hidden: true });
  const button = btn(label, { iconName: 'camera', size: 'sm', variant: emphasize ? 'primary' : '', onClick: () => input.click() });
  const set = (dataUrl) => {
    value = dataUrl;
    preview.replaceChildren();
    if (dataUrl) {
      preview.append(
        h('img', { src: dataUrl, alt: 'Photo preview' }),
        h('button', { type: 'button', title: 'Remove photo', onclick: () => set(null) }, icon('x')),
      );
    }
    preview.hidden = !dataUrl;
    button.querySelector('span:last-child').textContent = dataUrl ? 'Retake' : label;
    onChange?.(dataUrl);
  };
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      set(await compressImage(file, { maxSize }));
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  const el = h('div', { class: 'photo-picker' }, button, preview, input);
  return {
    el,
    get value() { return value; },
    setEmphasis(on) {
      button.classList.toggle('btn-primary', on);
    },
  };
}
