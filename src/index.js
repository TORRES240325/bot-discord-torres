const { Client, GatewayIntentBits, Partials } = require('discord.js');
const config = require('./config');
const { createProtectionModule } = require('./modules/protection');
const { createTicketsModule } = require('./modules/tickets');
const { createAnnouncerModule } = require('./modules/announcer');
const { createWelcomeModule } = require('./modules/welcome');
const { createLogsModule } = require('./modules/logs');
const { createVerifyModule } = require('./modules/verify');
const { createRaidModule } = require('./modules/raid');
const { createDashboard } = require('./dashboard/server');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
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
];

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  
  // Iniciar dashboard web
  const dashboard = createDashboard(client, config);
  dashboard.start();
});

client.on('messageCreate', async (message) => {
  for (const m of modules) {
    if (typeof m.onMessageCreate === 'function') {
      await m.onMessageCreate(message, client);
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  for (const m of modules) {
    if (typeof m.onInteractionCreate === 'function') {
      await m.onInteractionCreate(interaction, client);
    }
  }
});

client.on('guildMemberAdd', async (member) => {
  for (const m of modules) {
    if (typeof m.onGuildMemberAdd === 'function') {
      await m.onGuildMemberAdd(member, client);
    }
  }
});

client.on('guildMemberRemove', async (member) => {
  for (const m of modules) {
    if (typeof m.onGuildMemberRemove === 'function') {
      await m.onGuildMemberRemove(member, client);
    }
  }
});

client.on('messageDelete', async (message) => {
  for (const m of modules) {
    if (typeof m.onMessageDelete === 'function') {
      await m.onMessageDelete(message, client);
    }
  }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  for (const m of modules) {
    if (typeof m.onMessageUpdate === 'function') {
      await m.onMessageUpdate(oldMessage, newMessage, client);
    }
  }
});

client.login(config.token).catch((err) => {
  console.error('Failed to login:', err);
  process.exit(1);
});
