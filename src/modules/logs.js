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
function cacheSet(key, val, ttlMs = 15000) {
  cache.set(key, { val, exp: Date.now() + ttlMs });
}

async function getLogsSettings(guildId) {
  const ck = `logs:${guildId}`;
  const cached = cacheGet(ck);
  if (cached) return cached;

  const db = getFirestore();
  if (!db) return null;

  try {
    const doc = await db.collection('guilds').doc(String(guildId)).collection('settings').doc('logs').get();
    const data = doc.exists ? (doc.data() || {}) : {};
    cacheSet(ck, data);
    return data;
  } catch (_) {
    return null;
  }
}

function canLog(guild, channelId) {
  if (!guild || !channelId) return false;
  const ch = guild.channels.cache.get(channelId);
  if (!ch || !ch.isTextBased?.()) return false;
  const me = guild.members.me;
  if (!me) return false;
  const perms = ch.permissionsFor(me);
  return Boolean(perms?.has(PermissionsBitField.Flags.ViewChannel) && perms?.has(PermissionsBitField.Flags.SendMessages));
}

function summarizeContent(str, max = 1500) {
  const s = String(str || '').trim();
  if (!s) return '(sin texto)';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function createLogsModule(config) {
  return {
    name: 'logs',

    async onGuildMemberAdd(member, client) {
      if (!member?.guild) return;
      const settings = await getLogsSettings(member.guild.id);
      if (!settings || settings.enabled === false) return;
      if (!settings.logJoins) return;
      const channelId = settings.channelId || config.logChannelId;
      if (!canLog(member.guild, channelId)) return;

      await logToChannel(client, channelId, {
        content: `✅ Join: ${member.user.tag} (${member.id}) | members: ${member.guild.memberCount}`,
      });
    },

    async onGuildMemberRemove(member, client) {
      if (!member?.guild) return;
      const settings = await getLogsSettings(member.guild.id);
      if (!settings || settings.enabled === false) return;
      if (!settings.logLeaves) return;
      const channelId = settings.channelId || config.logChannelId;
      if (!canLog(member.guild, channelId)) return;

      const tag = member.user?.tag || member.id;
      await logToChannel(client, channelId, {
        content: `🚪 Leave: ${tag} (${member.id}) | members: ${member.guild.memberCount}`,
      });
    },

    async onMessageDelete(message, client) {
      const guild = message.guild;
      if (!guild) return;
      if (message.author?.bot) return;
      const settings = await getLogsSettings(guild.id);
      if (!settings || settings.enabled === false) return;
      if (!settings.logMessageDelete) return;

      const channelId = settings.channelId || config.logChannelId;
      if (!canLog(guild, channelId)) return;

      const author = message.author ? `${message.author.tag} (${message.author.id})` : '(autor desconocido)';
      const content = summarizeContent(message.content);
      await logToChannel(client, channelId, {
        content: `🗑️ Mensaje borrado en <#${message.channel?.id}> por ${author}\n\n${content}`,
      });
    },

    async onMessageUpdate(oldMessage, newMessage, client) {
      const guild = newMessage.guild;
      if (!guild) return;
      if (newMessage.author?.bot) return;

      const settings = await getLogsSettings(guild.id);
      if (!settings || settings.enabled === false) return;
      if (!settings.logMessageEdit) return;

      const channelId = settings.channelId || config.logChannelId;
      if (!canLog(guild, channelId)) return;

      const before = summarizeContent(oldMessage?.content);
      const after = summarizeContent(newMessage?.content);
      if (before === after) return;

      const author = newMessage.author ? `${newMessage.author.tag} (${newMessage.author.id})` : '(autor desconocido)';
      await logToChannel(client, channelId, {
        content: `✏️ Mensaje editado en <#${newMessage.channel?.id}> por ${author}\n\nANTES:\n${before}\n\nDESPUÉS:\n${after}`,
      });
    },
  };
}

module.exports = {
  createLogsModule,
};
