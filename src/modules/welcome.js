const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

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

async function getWelcomeSettings(guildId) {
  const db = getFirestore();
  if (!db) return null;
  try {
    const doc = await db.collection('guilds').doc(String(guildId)).collection('settings').doc('welcome').get();
    if (!doc.exists) return null;
    return doc.data() || null;
  } catch (_) {
    return null;
  }
}

function applyPlaceholders(text, vars) {
  if (text == null) return '';
  return String(text)
    .replaceAll('{user}', vars.user)
    .replaceAll('{userId}', vars.userId)
    .replaceAll('{mention}', vars.mention)
    .replaceAll('{guildName}', vars.guildName)
    .replaceAll('{guildId}', vars.guildId)
    .replaceAll('{memberCount}', vars.memberCount);
}

function buildComponentsFromButtons(buttons, vars) {
  const components = [];
  if (Array.isArray(buttons) && buttons.length > 0) {
    const row = new ActionRowBuilder();
    for (const btn of buttons.slice(0, 5)) {
      const button = new ButtonBuilder().setLabel(applyPlaceholders(btn.label || 'Botón', vars).slice(0, 80));
      if (btn.url) {
        button.setStyle(ButtonStyle.Link).setURL(String(btn.url));
      } else {
        button.setStyle(ButtonStyle[btn.style] || ButtonStyle.Primary);
        button.setCustomId(btn.customId || `welcome_btn_${Date.now()}_${Math.random()}`);
      }
      if (btn.emoji) button.setEmoji(btn.emoji);
      row.addComponents(button);
    }
    components.push(row);
  }
  return components;
}

function safeHexColor(input, fallback = '#ff2d2d') {
  const s = String(input || '').trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(s)) return s.startsWith('#') ? s : `#${s}`;
  return fallback;
}

function buildEmbedFromData(embed, vars) {
  const eb = new EmbedBuilder();
  if (embed?.title) eb.setTitle(applyPlaceholders(embed.title, vars).slice(0, 256));
  if (embed?.description) eb.setDescription(applyPlaceholders(embed.description, vars).slice(0, 4096));
  if (embed?.color) eb.setColor(safeHexColor(embed.color));
  if (embed?.thumbnail) eb.setThumbnail(String(embed.thumbnail));
  if (embed?.image) eb.setImage(String(embed.image));
  if (embed?.footer) eb.setFooter({ text: applyPlaceholders(embed.footer, vars).slice(0, 2048) });
  if (embed?.timestamp) eb.setTimestamp();
  if (Array.isArray(embed?.fields)) {
    eb.addFields(
      embed.fields.slice(0, 25).map((f) => ({
        name: applyPlaceholders(f.name || 'Campo', vars).slice(0, 256),
        value: applyPlaceholders(f.value || '-', vars).slice(0, 1024),
        inline: Boolean(f.inline),
      }))
    );
  }
  return eb;
}

function createWelcomeModule(config) {
  return {
    name: 'welcome',
    async onGuildMemberAdd(member, client) {
      if (!member?.guild) return;
      if (member.user?.bot) return;

      const settings = await getWelcomeSettings(member.guild.id);
      if (!settings || settings.enabled === false) return;

      const channelId = settings.channelId || settings.welcomeChannelId;
      if (!channelId) return;

      const channel = await member.guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased?.()) return;

      const vars = {
        user: member.user.username,
        userId: member.id,
        mention: `<@${member.id}>`,
        guildName: member.guild.name,
        guildId: String(member.guild.id),
        memberCount: String(member.guild.memberCount ?? ''),
      };

      const contentParts = [];
      if (settings.pingUser) contentParts.push(vars.mention);
      if (settings.content) contentParts.push(applyPlaceholders(settings.content, vars));
      const content = contentParts.join(' ').trim();

      const payload = {};
      if (content) payload.content = content;

      if (settings.embed && typeof settings.embed === 'object') {
        payload.embeds = [buildEmbedFromData(settings.embed, vars)];
      }

      if (settings.buttons) {
        payload.components = buildComponentsFromButtons(settings.buttons, vars);
      }

      if (!payload.content && (!payload.embeds || payload.embeds.length === 0)) return;

      const sent = await channel.send(payload).catch(() => null);
      if (!sent) return;

      const deleteAfterSeconds = Number(settings.deleteAfterSeconds);
      if (deleteAfterSeconds > 0) {
        setTimeout(() => sent.delete().catch(() => null), deleteAfterSeconds * 1000);
      }
    },
  };
}

module.exports = {
  createWelcomeModule,
};
