const header = (subject, contentType) =>
  `From: Generator <generator@example.test>\r\nTo: Recipient <recipient@example.test>\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: ${contentType}\r\n\r\n`;

export const generateNestedMultipart = (depth) => {
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 1024) {
    throw new RangeError("Depth must be an integer from 1 through 1024.");
  }
  let body = "leaf\r\n";
  for (let index = depth; index >= 1; index -= 1) {
    const boundary = `depth-${String(index)}`;
    body = `${header(`depth-${String(index)}`, `multipart/mixed; boundary="${boundary}"`)}--${boundary}\r\n${body}\r\n--${boundary}--\r\n`;
  }
  return Buffer.from(body, "utf8");
};

export const generateAttachmentBomb = (count) => {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) {
    throw new RangeError("Attachment count must be an integer from 1 through 10000.");
  }
  const boundary = "attachment-bomb";
  const parts = Array.from(
    { length: count },
    (_, index) =>
      `--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="${String(index)}.bin"\r\n\r\nx\r\n`,
  ).join("");
  return Buffer.from(
    `${header("attachment-bomb", `multipart/mixed; boundary="${boundary}"`)}${parts}--${boundary}--\r\n`,
    "utf8",
  );
};
