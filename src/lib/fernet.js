import fernet from "fernet";
import { getSecret } from "./secrets.js";

// The Nx Witness per-site passwords are stored encrypted with Python's
// cryptography.Fernet (the tokens in the dump start with "gAAAA..."). The
// `fernet` npm package is wire-compatible, so the same base64 key decrypts them.
//
// nx_credential_encryption_key is a urlsafe-base64 32-byte key; the `fernet`
// lib wants the key as its `Secret`.

async function secret() {
  const key = await getSecret("nxCredentialEncryptionKey");
  return new fernet.Secret(key);
}

export async function decryptNxPassword(encrypted) {
  const token = new fernet.Token({
    secret: await secret(),
    token: encrypted,
    ttl: 0, // these tokens never expire — disable TTL enforcement
  });
  return token.decode();
}

export async function encryptNxPassword(plain) {
  const token = new fernet.Token({ secret: await secret() });
  return token.encode(plain);
}
