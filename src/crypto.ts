import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("[verix] ENCRYPTION_KEY is not set");
  return Buffer.from(key, "base64");
}

export function decrypt(encrypted: string): string {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, ciphertext] = encrypted.split(":");

  if (!ivHex || !authTagHex || !ciphertext) {
    throw new Error("[verix] Invalid encrypted format (expected iv:authTag:ciphertext)");
  }

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
