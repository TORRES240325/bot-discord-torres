const { PermissionsBitField } = require('discord.js');
const { logToChannel } = require('../utils/log');

const urlRegex = /(https?:\/\/|www\.)\S+/i;
const inviteRegex = /(discord\.gg\/|discord\.com\/invite\/)\S+/i;

let firebaseAdmin = null;
let firestoreDb = null;

function getFirestore() {
  if (firestoreDb) return firestoreDb;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;

  try {
    firebaseAdmin = require('firebase-admin');
    const serviceAccount = JSON.parse(raw);

    if (serviceAccount && typeof serviceAccount === 'object' && typeof serviceAccount.private_key === 'string') {
      if (serviceAccount.private_key.includes('\\n')) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      }
    }

    if (firebaseAdmin.apps.length === 0) {
      firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.cert(serviceAccount),
      });
    }

    firestoreDb = firebaseAdmin.firestore();
    return firestoreDb;
  } catch (_) {
    return null;
  }
}

const cache = new Map();
function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) {
    cache.delete(key);
    return null;
  }
  return v.val;
}
function cacheSet(key, val, ttlMs = 12000) {
  cache.set(key, { val, exp: Date.now() + ttlMs });
}

async function getModerationSettings(guildId, config) {
  const ck = `mod:${guildId}`;
  const cached = cacheGet(ck);
  if (cached) return cached;

  const db = getFirestore();
  if (!db) {
    const fallback = {
      enabled: true,
      blockLinks: Boolean(config.blockLinks),
      blockInvites: Boolean(config.blockInvites),
      spamEnabled: true,
      spamWindowMs: Number(config.spamWindowMs || 7000),
      spamMaxMsgs: Number(config.spamMaxMsgs || 6),
      spamTimeoutMs: Number(config.spamTimeoutMs || 60000),
      whitelistDomains: [],
      exemptRoleIds: [],
      exemptChannelIds: [],
      logChannelId: config.logChannelId || null,
    };
    cacheSet(ck, fallback);
    return fallback;
  }

  try {
    const doc = await db.collection('guilds').doc(String(guildId)).collection('settings').doc('moderation').get();
    const data = doc.exists ? (doc.data() || {}) : {};
    const merged = {
      enabled: data.enabled !== false,
      blockLinks: data.blockLinks != null ? Boolean(data.blockLinks) : Boolean(config.blockLinks),
      blockInvites: data.blockInvites != null ? Boolean(data.blockInvites) : Boolean(config.blockInvites),
      spamEnabled: data.spamEnabled != null ? Boolean(data.spamEnabled) : true,
      spamWindowMs: Number(data.spamWindowMs || config.spamWindowMs || 7000),
      spamMaxMsgs: Number(data.spamMaxMsgs || config.spamMaxMsgs || 6),
      spamTimeoutMs: Number(data.spamTimeoutMs || config.spamTimeoutMs || 60000),
      whitelistDomains: Array.isArray(data.whitelistDomains) ? data.whitelistDomains : [],
      exemptRoleIds: Array.isArray(data.exemptRoleIds) ? data.exemptRoleIds : [],
      exemptChannelIds: Array.isArray(data.exemptChannelIds) ? data.exemptChannelIds : [],
      logChannelId: data.logChannelId || config.logChannelId || null,
    };
    cacheSet(ck, merged);
    return merged;
  } catch (_) {
    const fallback = {
      enabled: true,
      blockLinks: Boolean(config.blockLinks),
      blockInvites: Boolean(config.blockInvites),
      spamEnabled: true,
      spamWindowMs: Number(config.spamWindowMs || 7000),
      spamMaxMsgs: Number(config.spamMaxMsgs || 6),
      spamTimeoutMs: Number(config.spamTimeoutMs || 60000),
      whitelistDomains: [],
      exemptRoleIds: [],
      exemptChannelIds: [],
      logChannelId: config.logChannelId || null,
    };
    cacheSet(ck, fallback);
    return fallback;
  }
}

function parseDomainsFromText(text) {
  const result = [];
  try {
    const matches = String(text || '').matchAll(/https?:\/\/([^\/\s]+)/gi);
    for (const m of matches) {
      const host = String(m[1] || '').toLowerCase();
      if (host) result.push(host);
    }
  } catch (_) {}
  return result;
}

function isWhitelisted(content, whitelistDomains) {
  if (!Array.isArray(whitelistDomains) || whitelistDomains.length === 0) return false;
  const domains = parseDomainsFromText(content);
  if (domains.length === 0) return false;
  const wl = whitelistDomains.map((d) => String(d || '').toLowerCase().trim()).filter(Boolean);
  return domains.some((d) => wl.some((allowed) => d === allowed || d.endsWith('.' + allowed)));
}

function createProtectionModule(config) {
  const userBuckets = new Map();

  function canModerate(message) {
    return message.member?.permissions?.has(PermissionsBitField.Flags.ManageMessages);
  }

  async function handleSpam(message, client) {
    const settings = await getModerationSettings(message.guild.id, config);
    if (!settings.enabled) return;
    if (!settings.spamEnabled) return;

    const now = Date.now();
    const userId = message.author.id;
    const bucket = userBuckets.get(userId) ?? [];
    const recent = bucket.filter((t) => now - t <= settings.spamWindowMs);
    recent.push(now);
    userBuckets.set(userId, recent);

    if (recent.length < settings.spamMaxMsgs) return;

    userBuckets.set(userId, []);

    const member = message.member;
    if (!member) return;

    if (member.moderatable) {
      await member.timeout(settings.spamTimeoutMs, 'Anti-spam').catch(() => null);
    }

    await message.channel.bulkDelete(10, true).catch(() => null);

    await logToChannel(client, settings.logChannelId, {
      content: `Anti-spam: ${message.author.tag} (${message.author.id}) en <#${message.channel.id}>`,
    });
  }

  async function handleFilters(message, client) {
    const settings = await getModerationSettings(message.guild.id, config);
    if (!settings.enabled) return;

    if (settings.exemptChannelIds?.includes(message.channel.id)) return;
    const roleIds = message.member?.roles?.cache?.map((r) => r.id) || [];
    if (settings.exemptRoleIds?.some((id) => roleIds.includes(id))) return;

    if (canModerate(message)) return;

    const content = message.content ?? '';

    if (settings.blockInvites && inviteRegex.test(content)) {
      await message.delete().catch(() => null);
      await logToChannel(client, settings.logChannelId, {
        content: `Filtro invites: eliminado mensaje de ${message.author.tag} (${message.author.id}) en <#${message.channel.id}>`,
      });
      return;
    }

    if (settings.blockLinks && urlRegex.test(content)) {
      if (isWhitelisted(content, settings.whitelistDomains)) return;
      await message.delete().catch(() => null);
      await logToChannel(client, settings.logChannelId, {
        content: `Filtro links: eliminado mensaje de ${message.author.tag} (${message.author.id}) en <#${message.channel.id}>`,
      });
    }
  }

  return {
    name: 'protection',
    async onMessageCreate(message, client) {
      if (!message.guild) return;
      if (message.author.bot) return;

      await handleFilters(message, client);

      if (!message.deleted) {
        await handleSpam(message, client);
      }
    },
  };
}

module.exports = {
  createProtectionModule,
};
