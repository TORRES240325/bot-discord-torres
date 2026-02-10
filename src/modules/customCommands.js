const { SlashCommandBuilder } = require('discord.js');

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

function normalizeName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

async function safeReply(interaction, content) {
  try {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ content: String(content) });
      return;
    }
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: String(content) });
    } else {
      await interaction.reply({ content: String(content) });
    }
  } catch (_) {
  }
}

async function getCustomCommandsSettings(guildId) {
  const ck = `custom:${guildId}`;
  const cached = cacheGet(ck);
  if (cached) return cached;

  const db = getFirestore();
  const fallback = { admins: [], commands: {} };
  if (!db) {
    cacheSet(ck, fallback);
    return fallback;
  }

  try {
    const doc = await db.collection('guilds').doc(String(guildId)).collection('settings').doc('customCommands').get();
    const data = doc.exists ? (doc.data() || {}) : {};
    const out = {
      admins: Array.isArray(data.admins) ? data.admins.map((x) => String(x)) : [],
      commands: (data.commands && typeof data.commands === 'object') ? data.commands : {},
    };
    cacheSet(ck, out);
    return out;
  } catch (_) {
    cacheSet(ck, fallback);
    return fallback;
  }
}

function createCustomCommandsModule(config) {
  const commands = [
    new SlashCommandBuilder()
      .setName('comando')
      .setDescription('Ejecutar un comando configurado desde el panel web')
      .addStringOption((o) => o
        .setName('nombre')
        .setDescription('Nombre del comando (ej: peru, mexico, paypal)')
        .setRequired(true)),
  ];

  return {
    name: 'customCommands',
    getSlashCommands() {
      return commands;
    },

    async onInteractionCreate(interaction, client) {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== 'comando') return;
      if (!interaction.guildId) return;

      try {
        try {
          if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
          }
        } catch (_) {
        }

        const requested = interaction.options.getString('nombre', true);
        const name = normalizeName(requested);
        if (!name) {
          await safeReply(interaction, '❌ Nombre inválido.');
          return;
        }

        const settings = await getCustomCommandsSettings(interaction.guildId);
        const admins = Array.isArray(settings.admins) ? settings.admins : [];
        const userId = String(interaction.user?.id || '');

        if (admins.length && !admins.includes(userId)) {
          await safeReply(interaction, '❌ No tienes permiso para usar estos comandos.');
          return;
        }

        const cmd = settings.commands && typeof settings.commands === 'object' ? settings.commands[name] : null;
        const response = cmd && typeof cmd === 'object' ? cmd.response : null;

        if (!response) {
          await safeReply(interaction, `❌ No existe el comando **${name}**. Créalo en el panel web.`);
          return;
        }

        await safeReply(interaction, String(response));
      } catch (err) {
        try {
          console.error('customCommands /comando error:', err);
        } catch (_) {
        }
        await safeReply(interaction, '❌ Ocurrió un error ejecutando el comando.');
      }
    },
  };
}

module.exports = {
  createCustomCommandsModule,
};
