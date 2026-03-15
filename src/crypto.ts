import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("[verix] ENCRYPTION_KEY is not set");
  return Buffer.from(key, "base64");
}

export function decrypt(encrypted: string): string {
  const key = getEncryptionKey();
  const parts = encrypted.split(":");

  if (parts.length !== 3) {
    throw new Error("[verix] Invalid encrypted format (expected iv:authTag:ciphertext)");
  }

  const iv = Buffer.from(parts[0]!, "hex");
  const authTag = Buffer.from(parts[1]!, "hex");
  const ciphertext = Buffer.from(parts[2]!, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted.toString("utf8");
}
