/**
 * QR rendering for the WeChat login flow.
 *
 * The iLink `qrcode_img_content` URL is an HTML page (it renders the QR with
 * JavaScript), NOT an image — `<img src=...>` cannot display it. Like the
 * reference project (which encodes the URL with qrcode-terminal), we encode
 * the URL string into a QR ourselves. The vendored encoder is
 * qrcode-generator (Kazuhiko Arase, MIT) — see src/vendor/qrcode.mjs.
 */

import qrcodeFactory from "./vendor/qrcode.mjs";

/** Render the login URL as an SVG QR code. */
export function qrSvgFor(url: string): string {
  const qr = qrcodeFactory(0, "M");
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({ cellSize: 2, margin: 2, scalable: true });
}
