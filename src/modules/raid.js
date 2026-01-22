const { PermissionsBitField } = require('discord.js');
const { logToChannel } = require('../utils/log');

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

async function getRaidSettings(guildId) {
  const ck = `raid:${guildId}`;
  const cached = cacheGet(ck);
  if (cached) return cached;

  const db = getFirestore();
  if (!db) {
    const fallback = {
      enabled: false,
      joinWindowMs: 15000,
      joinThreshold: 8,
      defenseDurationMs: 300000,
      slowmodeSeconds: 10,
      lockLinks: true,
      logChannelId: null,
    };
    cacheSet(ck, fallback);
    return fallback;
  }

  try {
    const doc = await db.collection('guilds').doc(String(guildId)).collection('settings').doc('raid').get();
    const data = doc.exists ? (doc.data() || {}) : {};
    const merged = {
      enabled: Boolean(data.enabled),
      joinWindowMs: Number(data.joinWindowMs || 15000),
      joinThreshold: Number(data.joinThreshold || 8),
      defenseDurationMs: Number(data.defenseDurationMs || 300000),
      slowmodeSeconds: Number(data.slowmodeSeconds || 10),
      lockLinks: data.lockLinks != null ? Boolean(data.lockLinks) : true,
      logChannelId: data.logChannelId || null,
    };
    cacheSet(ck, merged);
    return merged;
  } catch (_) {
    const fallback = {
      enabled: false,
      joinWindowMs: 15000,
      joinThreshold: 8,
      defenseDurationMs: 300000,
      slowmodeSeconds: 10,
      lockLinks: true,
      logChannelId: null,
    };
    cacheSet(ck, fallback);
    return fallback;
  }
}

const joinBuckets = new Map();
const defenseState = new Map();

async function setSlowmodeAllText(guild, seconds) {
  await guild.channels.fetch().catch(() => null);
  const me = guild.members.me;
  if (!me) return;

  const chans = guild.channels.cache.filter((c) => c.type === 0 && c.isTextBased?.());
  for (const ch of chans.values()) {
    const perms = ch.permissionsFor(me);
    if (!perms?.has(PermissionsBitField.Flags.ManageChannels)) continue;
    await ch.setRateLimitPerUser(seconds, 'Anti-raid').catch(() => null);
  }
}

function createRaidModule(config) {
  return {
    name: 'raid',

    async onGuildMemberAdd(member, client) {
      if (!member?.guild) return;
      if (member.user?.bot) return;

      const settings = await getRaidSettings(member.guild.id);
      if (!settings.enabled) return;

      const now = Date.now();
      const bucket = joinBuckets.get(member.guild.id) ?? [];
      const recent = bucket.filter((t) => now - t <= settings.joinWindowMs);
      recent.push(now);
      joinBuckets.set(member.guild.id, recent);

      const active = defenseState.get(member.guild.id);
      if (active && now < active.until) return;

      if (recent.length < settings.joinThreshold) return;

      const until = now + settings.defenseDurationMs;
      defenseState.set(member.guild.id, { until });

      if (settings.slowmodeSeconds > 0) {
        await setSlowmodeAllText(member.guild, settings.slowmodeSeconds);
      }

      const logChannelId = settings.logChannelId || config.logChannelId;
      if (logChannelId) {
        await logToChannel(client, logChannelId, {
          content: `🚨 Anti-raid ACTIVADO en **${member.guild.name}**: ${recent.length} joins en ${settings.joinWindowMs}ms. Duración: ${Math.round(settings.defenseDurationMs / 1000)}s.`,
        });
      }

      setTimeout(async () => {
        const state = defenseState.get(member.guild.id);
        if (!state) return;
        if (Date.now() < state.until) return;

        defenseState.delete(member.guild.id);
        if (settings.slowmodeSeconds > 0) {
          await setSlowmodeAllText(member.guild, 0);
        }

        if (logChannelId) {
          await logToChannel(client, logChannelId, {
            content: `✅ Anti-raid DESACTIVADO en **${member.guild.name}**`,
          });
        }
      }, settings.defenseDurationMs + 2000);
    },
  };
}

module.exports = {
  createRaidModule,
};
