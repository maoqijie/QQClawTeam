import QRCode from 'qrcode';

export async function generateQrCodeSvg(content: string): Promise<string> {
  return QRCode.toString(content, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
  });
}

export async function generateQrCodePngBase64(
  content: string,
): Promise<string> {
  const dataUrl = await QRCode.toDataURL(content, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 360,
  });
  return dataUrl.replace(/^data:image\/png;base64,/, '');
}
