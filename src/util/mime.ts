const MIME: Record<string, string> = {
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', xml: 'application/xml', csv: 'text/csv; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  svg: 'image/svg+xml', ico: 'image/x-icon', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', psd: 'image/vnd.adobe.photoshop',
  pdf: 'application/pdf', zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo', ts: 'video/mp2t',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', url: 'application/octet-stream'
};

export function mimeOfExt(ext: string): string {
  return MIME[ext.toLowerCase()] ?? 'application/octet-stream';
}
