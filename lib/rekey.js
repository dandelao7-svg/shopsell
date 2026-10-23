/* ============================================================
   NEXTLAO — LIB/REKEY.JS
   One-time re-encryption of stored secrets after ENCRYPTION_KEY
   is rotated (see lib/crypto.js). Runs at startup only while
   ENCRYPTION_KEY_OLD is set; safe to run repeatedly — rows already
   under the new key are skipped.
   ============================================================ */

'use strict';

const cryptoLib = require('./crypto');

// Every column that holds lib/crypto ciphertext, with its row key.
const TARGETS = [
  { table: 'carrier_accounts',    keyCols: ['seller_id', 'carrier'], col: 'credentials' },
  { table: 'channel_connections', keyCols: ['seller_id', 'channel'], col: 'credentials' },
  { table: 'stripe_keys',         keyCols: ['seller_id'],            col: 'secret_key' },
  { table: 'stripe_keys',         keyCols: ['seller_id'],            col: 'webhook_secret' },
];

async function rekeyAll(pool, log = console) {
  if (!cryptoLib.isRotating()) return null;
  const summary = {};
  for (const { table, keyCols, col } of TARGETS) {
    const label = `${table}.${col}`;
    summary[label] = { moved: 0, alreadyNew: 0, unreadable: 0 };
    const { rows } = await pool.query(
      `SELECT ${keyCols.join(', ')}, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`);
    for (const row of rows) {
      const fresh = cryptoLib.reencrypt(row.v);
      if (!fresh) {
        // Either already under the new key, or plaintext/legacy/unreadable.
        try { cryptoLib.decrypt(row.v); summary[label].alreadyNew++; } catch { summary[label].unreadable++; }
        continue;
      }
      const where = keyCols.map((k, i) => `${k} = $${i + 2}`).join(' AND ');
      await pool.query(`UPDATE ${table} SET ${col} = $1 WHERE ${where}`, [fresh, ...keyCols.map((k) => row[k])]);
      summary[label].moved++;
    }
  }
  log.log('[rekey] ENCRYPTION_KEY rotation:', JSON.stringify(summary),
    '— when nothing shows as "moved" on a later start, remove ENCRYPTION_KEY_OLD.');
  return summary;
}

module.exports = { rekeyAll };
