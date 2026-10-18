/* Minimal ZIP writer (store method, no compression) with no dependencies.
   Code answers are small text, so skipping deflate keeps this readable and
   every archive stays openable by Windows Explorer, unzip and 7-Zip. */
window.Zip = (() => {
  'use strict';

  const encoder = new TextEncoder();

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  // DOS timestamps are what the ZIP format stores; the epoch starts in 1980.
  function dosTime(date) {
    return (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  }

  function dosDate(date) {
    const year = Math.max(1980, date.getFullYear());
    return ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  }

  function toBytes(content) {
    if (content instanceof Uint8Array) return content;
    return encoder.encode(String(content ?? ''));
  }

  function sanitize(name, index) {
    // A model can emit "../../etc/passwd" as a filename; keep it inside the archive.
    // Parts are compared after trimming, because " ../x" is the same escape as
    // "../x" but only the padded one survives a literal dot-dot filter. Any
    // all-dots part ("...", "..") is a traversal or a no-op, never a real name.
    const cleaned = String(name || '')
      .replace(/\\/g, '/')
      .split('/')
      .map((part) => part.trim())
      .filter((part) => part && !/^\.+$/.test(part))
      .join('/')
      .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
      .slice(-180);
    return cleaned || `file-${index + 1}.txt`;
  }

  /**
   * @param {{name:string, content:string|Uint8Array}[]} files
   * @returns {Blob}
   */
  function create(files, { comment = '' } = {}) {
    const list = (files || []).map((f, i) => ({
      name: sanitize(f.name, i),
      bytes: toBytes(f.content),
      when: f.date instanceof Date ? f.date : new Date()
    }));

    const chunks = [];
    const central = [];
    let offset = 0;

    for (const file of list) {
      const nameBytes = encoder.encode(file.name);
      const crc = crc32(file.bytes);
      const time = dosTime(file.when);
      const date = dosDate(file.when);

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true); // version needed
      lv.setUint16(6, 0x0800, true); // flag: names are UTF-8
      lv.setUint16(8, 0, true); // method: store
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, file.bytes.length, true);
      lv.setUint32(22, file.bytes.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      chunks.push(local, file.bytes);

      const entry = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(entry.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true); // version made by
      cv.setUint16(6, 20, true); // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, file.bytes.length, true);
      cv.setUint32(24, file.bytes.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true); // extra
      cv.setUint16(32, 0, true); // comment
      cv.setUint16(34, 0, true); // disk start
      cv.setUint16(36, 0, true); // internal attrs
      cv.setUint32(38, 0, true); // external attrs
      cv.setUint32(42, offset, true); // local header offset
      entry.set(nameBytes, 46);
      central.push(entry);

      offset += local.length + file.bytes.length;
    }

    let centralSize = 0;
    for (const entry of central) {
      chunks.push(entry);
      centralSize += entry.length;
    }

    const commentBytes = encoder.encode(comment);
    const end = new Uint8Array(22 + commentBytes.length);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, list.length, true);
    ev.setUint16(10, list.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, commentBytes.length, true);
    end.set(commentBytes, 22);
    chunks.push(end);

    return new Blob(chunks, { type: 'application/zip' });
  }

  function download(files, zipName, options) {
    const blob = create(files, options);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = zipName || 'code.zip';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoke on a timer: Safari needs the click to settle first.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return blob.size;
  }

  return { create, download, crc32, sanitize };
})();
