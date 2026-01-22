const { PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

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

async function getVerifySettings(guildId) {
  const ck = `verify:${guildId}`;
  const cached = cacheGet(ck);
  if (cached) return cached;

  const db = getFirestore();
  if (!db) return null;

  try {
    const doc = await db.collection('guilds').doc(String(guildId)).collection('settings').doc('verify').get();
    const data = doc.exists ? (doc.data() || {}) : {};
    cacheSet(ck, data);
    return data;
  } catch (_) {
    return null;
  }
}

function createVerifyModule(config) {
  return {
    name: 'verify',

    async onGuildMemberAdd(member) {
      if (!member?.guild) return;
      if (member.user?.bot) return;

      const settings = await getVerifySettings(member.guild.id);
      if (!settings || settings.enabled === false) return;

      const autoRoleId = settings.autoRoleId;
      if (autoRoleId) {
        await member.roles.add(autoRoleId).catch(() => null);
      }
    },

    async onInteractionCreate(interaction) {
      if (!interaction.isButton()) return;
      if (interaction.customId !== 'verify_me') return;
      if (!interaction.guild) return;

      const settings = await getVerifySettings(interaction.guild.id);
      if (!settings || settings.enabled === false) {
        return interaction.reply({ content: 'Verificación desactivada.', ephemeral: true }).catch(() => null);
      }

      const roleId = settings.roleId;
      if (!roleId) {
        return interaction.reply({ content: 'Rol de verificación no configurado.', ephemeral: true }).catch(() => null);
      }

      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!member) {
        return interaction.reply({ content: 'No se pudo obtener tu miembro.', ephemeral: true }).catch(() => null);
      }

      await member.roles.add(roleId, 'Verificación').catch(() => null);
      return interaction.reply({ content: '✅ Verificado!', ephemeral: true }).catch(() => null);
    },

    async buildVerifyPanel(guildId) {
      const settings = await getVerifySettings(guildId);
      const title = settings?.panelTitle || '✅ Verificación';
      const description = settings?.panelDescription || 'Presiona el botón para verificarte.';

      const embed = new EmbedBuilder()
        .setTitle(String(title).slice(0, 256))
        .setDescription(String(description).slice(0, 4096))
        .setColor(settings?.panelColor || '#ff2d2d');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('verify_me')
          .setLabel(settings?.buttonLabel || 'Verificarme')
          .setStyle(ButtonStyle.Success)
      );

      return { embeds: [embed], components: [row] };
    },
  };
}

module.exports = {
  createVerifyModule,
};
