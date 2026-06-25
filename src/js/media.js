// ============================================================================
//  media.js — browser photo capture (no framework). Opens the device camera /
//  file picker, downscales + compresses to a JPEG, and returns { mime, b64, w,
//  h } ready to upload to /api/photos. Keeps payloads small enough for the
//  capped server store (and `out of` /api/state).
// ============================================================================

export function supportsPhotos() {
  return typeof document !== 'undefined' && typeof FileReader !== 'undefined';
}

// Prompt for a photo. `camera:true` asks phones for the rear camera directly.
// Resolves to { mime:'image/jpeg', b64, w, h } or null if cancelled/failed.
export function capturePhoto({ camera = false, maxDim = 1280, quality = 0.8 } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (camera) input.setAttribute('capture', 'environment');
    input.style.cssText = 'position:fixed;left:-9999px;opacity:0';
    input.onchange = () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) { resolve(null); return; }
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        const scale = Math.min(1, maxDim / Math.max(w, h || 1));
        w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        let dataUrl;
        try { dataUrl = canvas.toDataURL('image/jpeg', quality); } catch { resolve(null); return; }
        resolve({ mime: 'image/jpeg', b64: dataUrl.split(',')[1] || '', w, h });
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    };
    document.body.appendChild(input);
    input.click();
  });
}
