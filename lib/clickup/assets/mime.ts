const PREFIXES: Array<{ mime: string; bytes: number[] }> = [
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
];

export const CLICKUP_ASSET_MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function startsWith(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value);
}

function textMime(bytes: Uint8Array, declared: string, fileName: string): string | null {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
  if (sample.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    return null;
  }
  const extension = fileName.toLowerCase().split(".").at(-1);
  if (declared === "text/csv" || extension === "csv") return "text/csv";
  if (declared === "text/markdown" || extension === "md" || extension === "markdown") {
    return "text/markdown";
  }
  return "text/plain";
}

/** Header e extensão são só pistas; assinatura/conteúdo decide o MIME persistido. */
export function sniffClickUpAssetMime(
  bytes: Uint8Array,
  declaredMime: string,
  fileName: string,
): string | null {
  for (const candidate of PREFIXES) if (startsWith(bytes, candidate.bytes)) return candidate.mime;
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    ["text/plain", "text/markdown", "text/csv"].includes(declaredMime) ||
    /\.(?:txt|md|markdown|csv)$/i.test(fileName)
  ) {
    return textMime(bytes, declaredMime, fileName);
  }
  return null;
}
