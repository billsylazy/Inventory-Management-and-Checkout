import { h, icon, iconBtn, feedback, btn, clear, focusIfIdle } from './ui.js';

// ---------------------------------------------------------------------------
// Barcode / QR scanning.
//
// Three ways to enter a tag, all ending in the same onScan(code) callback:
//   1. the phone/laptop camera (html5-qrcode, which uses the browser's native
//      BarcodeDetector when available),
//   2. a USB/Bluetooth scanner, which "types" the code and presses Enter,
//   3. typing the tag by hand.

let libraryPromise;
function loadLibrary() {
  if (window.__Html5QrcodeLibrary__) return Promise.resolve(window.__Html5QrcodeLibrary__);
  libraryPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/html5-qrcode.min.js';
    script.onload = () => resolve(window.__Html5QrcodeLibrary__);
    script.onerror = () => {
      libraryPromise = null;
      reject(new Error('Could not load the scanner'));
    };
    document.head.append(script);
  });
  return libraryPromise;
}

let active = null;

/** Stops the camera if a scanner overlay is open (called on navigation). */
export function closeActiveScanner() {
  active?.close();
}

const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

/**
 * Opens a full-screen camera scanner.
 * onScan(code) may return {ok, message} (or a promise of it) for feedback.
 * In continuous mode the camera stays open for the next item.
 */
export function openCameraScanner({ title = 'Scan a tag', onScan, continuous = false, hint }) {
  closeActiveScanner();
  let scanner = null;
  let closed = false;
  let busy = false;
  let lastCode = '';
  let lastAt = 0;

  const flash = h('div', { class: 'scanner-flash' });
  const result = h('div', { class: 'scanner-result' }, icon('scan'), h('span', null, hint ?? 'Point the camera at a barcode or QR code'));
  const message = h('p', { class: 'scanner-msg' });
  const reader = h('div', { id: 'qr-reader' });

  const overlay = h('div', { class: 'scanner-overlay', role: 'dialog', 'aria-label': title },
    h('div', { class: 'scanner-top' }, h('h2', null, title), iconBtn('x', { title: 'Close scanner', onClick: () => close() })),
    h('div', { class: 'scanner-view' }, reader, flash),
    h('div', { class: 'scanner-bottom' }, result, message,
      btn(continuous ? 'Done' : 'Cancel', { onClick: () => close(), variant: continuous ? 'primary' : '' })));

  const close = async () => {
    if (closed) return;
    closed = true;
    active = null;
    document.removeEventListener('keydown', onKey);
    try {
      if (scanner?.isScanning) await scanner.stop();
      scanner?.clear();
    } catch {
      // camera already released
    }
    overlay.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  active = { close };
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);

  const show = (ok, text) => {
    result.className = `scanner-result ${ok ? 'ok' : 'err'}`;
    clear(result, icon(ok ? 'check-circle' : 'x-circle'), h('span', null, text));
    flash.className = `scanner-flash ${ok ? 'ok' : 'err'}`;
    setTimeout(() => { flash.className = 'scanner-flash'; }, 350);
    feedback(ok);
  };

  const handle = async (code) => {
    const now = Date.now();
    if (busy || closed) return;
    if (code === lastCode && now - lastAt < 2500) return; // same tag still in view
    lastCode = code;
    lastAt = now;
    busy = true;
    try {
      const outcome = (await onScan(code)) ?? { ok: true, message: code };
      show(outcome.ok !== false, outcome.message ?? code);
      if (!continuous && outcome.ok !== false) setTimeout(close, 450);
    } catch (err) {
      show(false, err.message);
    } finally {
      busy = false;
    }
  };

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    message.textContent = 'The camera only works over a secure (https://) connection. Ask your teacher for the https address, or type the tag / use a USB scanner instead.';
    clear(result, icon('alert'), h('span', null, 'Camera not available on this connection'));
    return { close };
  }

  loadLibrary().then(async (lib) => {
    if (closed) return;
    const F = lib.Html5QrcodeSupportedFormats;
    scanner = new lib.Html5Qrcode('qr-reader', {
      verbose: false,
      formatsToSupport: [F.QR_CODE, F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODABAR, F.ITF, F.DATA_MATRIX],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    });
    try {
      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 12,
          qrbox: (w, hgt) => ({ width: Math.max(60, Math.floor(w * 0.82)), height: Math.max(60, Math.floor(Math.min(hgt * 0.62, w * 0.62))) }),
        },
        (text) => handle(text.trim()),
        () => {},
      );
      if (closed) await scanner.stop();
    } catch (err) {
      const denied = /permission|notallowed/i.test(String(err?.name ?? err));
      message.textContent = denied
        ? 'Camera permission was blocked. Allow camera access in your browser settings, or type the tag instead.'
        : 'No camera could be started on this device. Type the tag or use a USB scanner instead.';
      clear(result, icon('alert'), h('span', null, 'Camera unavailable'));
    }
  }).catch((err) => {
    message.textContent = err.message;
  });

  return { close };
}

/**
 * Text field + camera button. Works with USB scanners (which type the code
 * and press Enter) and manual typing; the camera button opens the scanner.
 */
export function scanField({
  placeholder = 'Scan or type a tag', onScan, continuous = true, buttonLabel = 'Add', autofocus = true,
  title = 'Scan a tag', hint,
}) {
  const input = h('input', {
    class: 'input', type: 'text', placeholder, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
    enterkeyhint: 'go', 'aria-label': placeholder,
  });
  const submit = async (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (!code) return;
    input.value = '';
    try {
      const outcome = await onScan(code);
      if (outcome) feedback(outcome.ok !== false);
    } finally {
      // Ready for the next scan, unless the user has moved on to another field.
      if (!isTouch()) focusIfIdle(input, { within: form });
    }
  };
  const form = h('form', { class: 'scan-field', onsubmit: submit },
    btn(isTouch() ? 'Scan' : 'Camera', { variant: 'primary', iconName: 'scan', onClick: () => openCameraScanner({ title, onScan, continuous, hint }) }),
    input,
    btn(buttonLabel, { type: 'submit' }));
  if (autofocus && !isTouch()) setTimeout(() => focusIfIdle(input), 50);
  form.focusInput = () => input.focus();
  return form;
}
