const mime = require("mime-types");

const DEFAULT_MIME_TYPE = "application/octet-stream";
const BASE64_DATA_URI_PATTERN =
  /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]*)$/i;

/**
 * Parse a base64 Data URL without restricting valid MIME tokens such as the
 * digit in video/mp4.
 *
 * @param {string} value
 * @returns {{ mimeType: string, buffer: Buffer } | null}
 */
function parseBase64DataUri(value) {
  if (typeof value !== "string") return null;

  const matches = value.match(BASE64_DATA_URI_PATTERN);
  if (!matches) return null;

  return {
    mimeType: matches[1],
    buffer: Buffer.from(matches[2], "base64"),
  };
}

/**
 * Prefer a specific MIME type supplied by the uploader. If it is missing or
 * generic, infer a more useful type from the original file name.
 *
 * @param {string | undefined | null} suppliedMimeType
 * @param {string | undefined | null} originalName
 * @returns {string}
 */
function resolveMimeType(suppliedMimeType, originalName) {
  const normalized = String(suppliedMimeType || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const inferred = originalName ? mime.lookup(originalName) : false;

  if (!normalized || normalized === DEFAULT_MIME_TYPE) {
    return inferred || DEFAULT_MIME_TYPE;
  }

  return normalized;
}

module.exports = {
  DEFAULT_MIME_TYPE,
  parseBase64DataUri,
  resolveMimeType,
};
