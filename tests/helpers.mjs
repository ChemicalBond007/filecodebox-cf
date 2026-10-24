import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

export function memoryD1() {
  const sqlite = new DatabaseSync(':memory:');
  class Statement {
    constructor(sql) { this.sql = sql; this.params = []; }
    bind(...params) { this.params = params; return this; }
    first() { return sqlite.prepare(this.sql).all(...this.params)[0] || null; }
    all() { return { results: sqlite.prepare(this.sql).all(...this.params) }; }
    run() {
      const result = sqlite.prepare(this.sql).run(...this.params);
      return { success: true, meta: { changes: Number(result.changes) } };
    }
  }
  return {
    prepare: sql => new Statement(sql),
    batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(s => s.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
    close: () => sqlite.close(),
  };
}

const hash = value => createHash('sha256').update(value).digest();
const b64 = value => Buffer.from(value).toString('base64url');
const counterBytes = count => { const b = Buffer.alloc(4); b.writeUInt32BE(count); return b; };

// 软件认证器，生成真实 P-256 公私钥和 DER 编码 ECDSA 签名，不 mock 验签库。
export class TestPasskey {
  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = privateKey;
    this.id = randomBytes(32);
    const jwk = publicKey.export({ format: 'jwk' });
    this.publicKey = isoCBOR.encode(new Map([
      [1, 2], [3, -7], [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
    ]));
    this.counter = 0;
  }
  register(options, origin, overrides = {}) {
    this.userId = options.user.id;
    const client = Buffer.from(JSON.stringify({
      type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false,
      ...overrides.client,
    }));
    const length = Buffer.alloc(2); length.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([
      hash(overrides.rpID || options.rp.id), Buffer.from([overrides.flags ?? 0x45]),
      counterBytes(0), Buffer.alloc(16), length, this.id, Buffer.from(this.publicKey),
    ]);
    return {
      id: b64(this.id), rawId: b64(this.id), type: 'public-key', clientExtensionResults: {},
      response: {
        clientDataJSON: b64(client), transports: ['internal'],
        attestationObject: b64(isoCBOR.encode(new Map([
          ['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)],
        ]))),
      },
    };
  }
  authenticate(options, origin, overrides = {}) {
    const client = Buffer.from(JSON.stringify({
      type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false,
      ...overrides.client,
    }));
    const count = overrides.counter ?? ++this.counter;
    const authData = Buffer.concat([
      hash(overrides.rpID || options.rpId), Buffer.from([overrides.flags ?? 0x05]), counterBytes(count),
    ]);
    const signature = sign('sha256', Buffer.concat([authData, hash(client)]), this.privateKey);
    return {
      id: b64(this.id), rawId: b64(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(client), authenticatorData: b64(authData),
        signature: b64(signature), userHandle: this.userId },
    };
  }
}

export async function bindTestAdmin(call, apiKey, origin) {
  const login = await call('POST', '/api/admin/login', { code: apiKey });
  assert.equal(login.status, 200);
  let cookie = login.headers.get('set-cookie').split(';')[0];
  const start = await call('POST', '/api/admin/passkey/register/options', {}, { Cookie: cookie });
  assert.equal(start.status, 200);
  const { options, challengeId } = await start.json();
  const key = new TestPasskey();
  const verify = await call('POST', '/api/admin/passkey/register/verify', {
    challengeId, response: key.register(options, origin),
  }, { Cookie: cookie });
  assert.equal(verify.status, 200, await verify.clone().text());
  cookie = verify.headers.get('set-cookie').split(';')[0];
  return { cookie, key, backupCode: (await verify.json()).backup_code };
}
