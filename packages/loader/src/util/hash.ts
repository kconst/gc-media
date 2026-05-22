import crypto from "node:crypto";
import fs from "node:fs";

/** sha1 of file bytes, used as the stable asset id. */
export function hashFile(localPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    const stream = fs.createReadStream(localPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
