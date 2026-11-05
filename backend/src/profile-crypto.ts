import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
export function profileCrypto(keyHex: string, namespace: string) {
  if (!/^[a-fA-F0-9]{64}$/.test(keyHex))
    throw new Error(
      "ARKIV_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters.",
    );
  const key = Buffer.from(keyHex, "hex");
  const walletTag = (address: string) =>
    createHmac("sha256", key)
      .update(`${namespace}:${address.toLowerCase()}`)
      .digest("hex");
  return {
    walletTag,
    encrypt(address: string, value: unknown) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(walletTag(address)));
      const data = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
      ]);
      return new Uint8Array(
        Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), data]),
      );
    },
    decrypt<T>(address: string, value: Uint8Array): T {
      const bytes = Buffer.from(value);
      if (bytes.length < 30 || bytes[0] !== 1)
        throw new Error("Unsupported encrypted profile");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(1, 13),
      );
      decipher.setAAD(Buffer.from(walletTag(address)));
      decipher.setAuthTag(bytes.subarray(13, 29));
      return JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(29)),
          decipher.final(),
        ]).toString("utf8"),
      ) as T;
    },
  };
}
