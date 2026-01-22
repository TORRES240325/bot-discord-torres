const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
dotenv.config({ path: envPath });

function tryLoadEnvManually() {
  try {
    if (!fs.existsSync(envPath)) return;
    const buf = fs.readFileSync(envPath);

    let text;
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      text = buf.toString('utf16le');
    } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      text = Buffer.from(buf).swap16().toString('utf16le');
    } else {
      text = buf.toString('utf8');
    }

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (_) {
    // ignore
  }
}

if (!process.env.DISCORD_TOKEN) {
  tryLoadEnvManually();
}

function required(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing ${name} in .env`);
  }
  return v;
}

function optional(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function optionalInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return n;
}

module.exports = {
  token: required('DISCORD_TOKEN'),
  logChannelId: optional('LOG_CHANNEL_ID', null),
  ticketCategoryId: optional('TICKET_CATEGORY_ID', null),
  ticketStaffRoleId: optional('TICKET_STAFF_ROLE_ID', null),
  spamMaxMsgs: optionalInt('SPAM_MAX_MSGS', 6),
  spamWindowMs: optionalInt('SPAM_WINDOW_MS', 7000),
  spamTimeoutMs: optionalInt('SPAM_TIMEOUT_MS', 60000),
  blockLinks: optionalInt('BLOCK_LINKS', 1) === 1,
  blockInvites: optionalInt('BLOCK_INVITES', 1) === 1,
  announcerPrefix: optional('ANNOUNCER_PREFIX', '!'),
  announcerRoles: optional('ANNOUNCER_ROLES', '').split(',').filter(r => r.trim()),
  dashboardPort: optionalInt('DASHBOARD_PORT', 3000),
  dashboardPassword: optional('DASHBOARD_PASSWORD', 'admin123'),
};
