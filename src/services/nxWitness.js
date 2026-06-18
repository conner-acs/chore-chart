import https from "https";
import { URL } from "url";

// Nx Witness VMS API client. Targets Nx Witness 6.0.x
// (/rest/v2/login/sessions, /rest/v2/devices, /media/{id}.mp4).
//
// Uses node:https directly for two reasons the global fetch can't easily give us:
//  1. TLS control — Nx servers use self-signed certs, so we disable verification
//     (or pin the site's PEM in nx_tls_cert), matching the Python httpx client.
//  2. True streaming — export_clip returns the raw response stream so the footage
//     Lambda can pipe MP4 chunks straight to the client (response streaming).

const CHUNK_TIMEOUT_MS = 10000;

export class NxWitnessError extends Error {}

export class NxWitnessClient {
  constructor({ host, username, password, tlsCert = null }) {
    this.host = host.replace(/\/$/, "");
    this.username = username;
    this.password = password;
    this.tlsCert = tlsCert;
  }

  _agent() {
    if (this.tlsCert) {
      // Pin the cert but skip hostname checks (issued to the internal name).
      return new https.Agent({ ca: this.tlsCert, checkServerIdentity: () => undefined });
    }
    return new https.Agent({ rejectUnauthorized: false });
  }

  _request(method, path, { headers = {}, body = null, timeout = CHUNK_TIMEOUT_MS } = {}) {
    const url = new URL(`${this.host}${path}`);
    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        { method, headers, agent: this._agent(), timeout },
        (res) => resolve(res)
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new NxWitnessError("Nx Witness request timed out")));
      if (body) req.write(body);
      req.end();
    });
  }

  async _readJson(res) {
    const chunks = [];
    for await (const c of res) chunks.push(c);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : {};
  }

  async _getSessionToken() {
    const res = await this._request("POST", "/rest/v2/login/sessions", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.username,
        password: this.password,
        setCookie: false,
      }),
    });
    if (res.statusCode !== 200) {
      throw new NxWitnessError(`Nx Witness authentication failed (${res.statusCode})`);
    }
    const data = await this._readJson(res);
    return data.token;
  }

  // Authenticate only — proves credentials work. The session token never leaves
  // the backend.
  async verifyConnection() {
    await this._getSessionToken();
  }

  async listDevices() {
    const token = await this._getSessionToken();
    const res = await this._request("GET", "/rest/v2/devices", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.statusCode !== 200) {
      throw new NxWitnessError(`Nx Witness device list failed (${res.statusCode})`);
    }
    let data = await this._readJson(res);
    if (data && !Array.isArray(data)) data = data.devices || data.reply || [];
    return data;
  }

  // Returns the raw MP4 response stream (a Readable) for the given camera/time
  // window. The caller pipes it to the client. Timestamps are epoch ms.
  async exportClipStream(cameraId, startMs, endMs) {
    const token = await this._getSessionToken();
    const res = await this._request(
      "GET",
      `/media/${cameraId}.mp4?pos=${startMs}&endPos=${endMs}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 300000 }
    );
    if (res.statusCode !== 200) {
      throw new NxWitnessError(`Nx Witness export failed (${res.statusCode})`);
    }
    return res; // Readable stream of MP4 bytes
  }
}
