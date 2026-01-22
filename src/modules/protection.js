const { PermissionsBitField } = require('discord.js');
const { logToChannel } = require('../utils/log');

const urlRegex = /(https?:\/\/|www\.)\S+/i;
const inviteRegex = /(discord\.gg\/|discord\.com\/invite\/)\S+/i;

function createProtectionModule(config) {
  const userBuckets = new Map();

  function canModerate(message) {
    return message.member?.permissions?.has(PermissionsBitField.Flags.ManageMessages);
  }

  async function handleSpam(message, client) {
    const now = Date.now();
    const userId = message.author.id;
    const bucket = userBuckets.get(userId) ?? [];
    const recent = bucket.filter((t) => now - t <= config.spamWindowMs);
    recent.push(now);
    userBuckets.set(userId, recent);

    if (recent.length < config.spamMaxMsgs) return;

    userBuckets.set(userId, []);

    const member = message.member;
    if (!member) return;

    if (member.moderatable) {
      await member.timeout(config.spamTimeoutMs, 'Anti-spam').catch(() => null);
    }

    await message.channel.bulkDelete(10, true).catch(() => null);

    await logToChannel(client, config.logChannelId, {
      content: `Anti-spam: ${message.author.tag} (${message.author.id}) en <#${message.channel.id}>`,
    });
  }

  async function handleFilters(message, client) {
    if (canModerate(message)) return;

    const content = message.content ?? '';

    if (config.blockInvites && inviteRegex.test(content)) {
      await message.delete().catch(() => null);
      await logToChannel(client, config.logChannelId, {
        content: `Filtro invites: eliminado mensaje de ${message.author.tag} (${message.author.id}) en <#${message.channel.id}>`,
      });
      return;
    }

    if (config.blockLinks && urlRegex.test(content)) {
      await message.delete().catch(() => null);
      await logToChannel(client, config.logChannelId, {
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
