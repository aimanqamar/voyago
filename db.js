'use strict';
/**
 * MySQL connection + automatic setup.
 * Settings come from db-config.json (edit with Notepad) and can be overridden
 * with environment variables: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const defaults = { host: 'localhost', port: 3306, user: 'root', password: '', database: 'voyago' };

function readConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(__dirname, 'db-config.json'), 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw new Error('db-config.json is not valid JSON: ' + e.message);
  }
  const env = process.env;
  const cfg = {
    host: env.DB_HOST || file.host || defaults.host,
    port: Number(env.DB_PORT || file.port || defaults.port),
    user: env.DB_USER || file.user || defaults.user,
    password: env.DB_PASSWORD !== undefined ? env.DB_PASSWORD : (file.password ?? defaults.password),
    database: env.DB_NAME || file.database || defaults.database,
  };
  if (!/^[A-Za-z0-9_]{1,64}$/.test(cfg.database)) throw new Error('Database name may only contain letters, numbers and underscores.');
  return cfg;
}

const state = { pool: null, cfg: null };

function friendly(err, cfg) {
  const code = err && err.code;
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND')
    return `Cannot reach MySQL at ${cfg.host}:${cfg.port}. Start MySQL first (in XAMPP click "Start" next to MySQL), then run this again.`;
  if (code === 'ER_ACCESS_DENIED_ERROR')
    return `MySQL refused the login for user "${cfg.user}". Open db-config.json and put the correct user and password.`;
  return `Database error: ${err.message}`;
}

/** Create the database + tables if they do not exist yet. */
async function init() {
  const cfg = readConfig();
  state.cfg = cfg;
  try {
    const boot = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password });
    await boot.query(`CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await boot.end();

    state.pool = mysql.createPool({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
      waitForConnections: true, connectionLimit: 10,
      dateStrings: true,          // DATE/DATETIME come back as plain strings
      charset: 'utf8mb4',
    });

    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    const statements = sql.split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean);
    for (const st of statements) await state.pool.query(st);
  } catch (err) {
    const e = new Error(friendly(err, cfg));
    e.cause = err;
    throw e;
  }
  return state.pool;
}

module.exports = {
  init,
  get pool() { return state.pool; },
  get config() { return state.cfg; },
};
