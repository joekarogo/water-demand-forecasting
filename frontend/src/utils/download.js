// Shared client-side file-download mechanics, used by every page's
// "Export CSV" button so they all behave identically. A UTF-8 BOM is
// prepended so the file opens correctly in Excel, which otherwise
// mis-detects the encoding of non-ASCII characters (e.g. İzmir district
// names, ₺).
export function downloadTextFile(filename, content, mimeType = 'text/csv;charset=utf-8') {
  const blob = new Blob(['﻿' + content], { type: mimeType });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
