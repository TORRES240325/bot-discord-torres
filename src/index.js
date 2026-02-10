const { Client, GatewayIntentBits, Partials } = require('discord.js');
const config = require('./config');
const { createProtectionModule } = require('./modules/protection');
const { createTicketsModule } = require('./modules/tickets');
const { createAnnouncerModule } = require('./modules/announcer');
const { createWelcomeModule } = require('./modules/welcome');
const { createLogsModule } = require('./modules/logs');
const { createVerifyModule } = require('./modules/verify');
const { createRaidModule } = require('./modules/raid');
const { createVoiceModule } = require('./modules/voice');
const { createUtilityModule } = require('./modules/utility');
const { createDashboard } = require('./dashboard/server');

process.on('unhandledRejection', (reason) => {
  try {
    console.error('[fatal] unhandledRejection:', reason);
  } catch (_) {
  }
});

process.on('uncaughtException', (err) => {
  try {
    console.error('[fatal] uncaughtException:', err);
  } catch (_) {
  }
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User],
});

const modules = [
  createProtectionModule(config),
  createTicketsModule(config),
  createAnnouncerModule(config),
  createWelcomeModule(config),
  createLogsModule(config),
  createVerifyModule(config),
  createRaidModule(config),
  createVoiceModule(config),
  createUtilityModule(config),
];

async function registerSlashCommands(client) {
  const commands = [];
  for (const m of modules) {
    if (typeof m.getSlashCommands === 'function') {
      const out = m.getSlashCommands();
      if (Array.isArray(out)) commands.push(...out);
    }
  }

  const seen = new Set();
  const unique = [];
  for (const c of commands) {
    const name = c?.name;
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    unique.push(c);
  }

  if (!client.application) return;
  const body = unique.map((c) => c.toJSON());
  const guildId = process.env.COMMANDS_GUILD_ID;
  if (guildId) {
    await client.application.commands.set(body, guildId);
  } else {
    await client.application.commands.set(body);
  }
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);

  Promise.resolve(registerSlashCommands(client)).catch((err) => console.error('Slash command register failed:', err));

  for (const m of modules) {
    if (typeof m.onReady === 'function') {
      Promise.resolve(m.onReady(client)).catch((err) => console.error('Module onReady failed:', err));
    }
  }
  
  // Iniciar dashboard web
  const dashboard = createDashboard(client, config);
  dashboard.start();
});

client.on('messageCreate', async (message) => {
  for (const m of modules) {
    if (typeof m.onMessageCreate === 'function') {
      try {
        await m.onMessageCreate(message, client);
      } catch (err) {
        try {
          console.error(`[module:${m.name || 'unknown'}] onMessageCreate failed:`, err);
        } catch (_) {
        }
      }
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  for (const m of modules) {
    if (typeof m.onInteractionCreate === 'function') {
      try {
        await m.onInteractionCreate(interaction, client);
      } catch (err) {
        try {
          console.error(`[module:${m.name || 'unknown'}] onInteractionCreate failed:`, err);
        } catch (_) {
        }
      }
    }
  }
});

client.on('guildMemberAdd', async (member) => {
  for (const m of modules) {
    if (typeof m.onGuildMemberAdd === 'function') {
      try {
        await m.onGuildMemberAdd(member, client);
      } catch (err) {
        try {
          console.error(`[module:${m.name || 'unknown'}] onGuildMemberAdd failed:`, err);
        } catch (_) {
        }
      }
    }
  }
});

client.on('guildMemberRemove', async (member) => {
  for (const m of modules) {
    if (typeof m.onGuildMemberRemove === 'function') {
      try {
        await m.onGuildMemberRemove(member, client);
      } catch (err) {
        try {
          console.error(`[module:${m.name || 'unknown'}] onGuildMemberRemove failed:`, err);
        } catch (_) {
        }
      }
    }
  }
});

client.on('messageDelete', async (message) => {
  for (const m of modules) {
    if (typeof m.onMessageDelete === 'function') {
      try {
        await m.onMessageDelete(message, client);
      } catch (err) {
        try {
          console.error(`[module:${m.name || 'unknown'}] onMessageDelete failed:`, err);
        } catch (_) {
        }
      }
    }
  }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  for (const m of modules) {
    if (typeof m.onMessageUpdate === 'function') {
      try {
        await m.onMessageUpdate(oldMessage, newMessage, client);
      } catch (err) {
        try {
          console.error(`[module:${m.name || 'unknown'}] onMessageUpdate failed:`, err);
        } catch (_) {
        }
      }
    }
  }
});

client.login(config.token).catch((err) => {
  console.error('Failed to login:', err);
  process.exit(1);
});
