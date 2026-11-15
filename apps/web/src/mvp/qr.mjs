import qrcode from 'qrcode-generator';

/** Real QR modules, with a four-module quiet zone. The URL never becomes SVG markup. */
export function qrSvg(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || url.length > 512) {
    throw new Error('유효한 모바일 연결 주소가 필요합니다.');
  }
  const code = qrcode(0, 'M');
  code.addData(url, 'Byte');
  code.make();
  const count = code.getModuleCount(), size = count + 8;
  let path = '';
  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) {
      if (code.isDark(row, column)) path += `M${column + 4} ${row + 4}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="300" height="300" role="img" aria-label="차량 연결 QR" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="white"/><path d="${path}" fill="black"/></svg>`;
}
