const { Client, GatewayIntentBits, Partials } = require('discord.js');
const config = require('./config');
const { createProtectionModule } = require('./modules/protection');
const { createTicketsModule } = require('./modules/tickets');
const { createAnnouncerModule } = require('./modules/announcer');
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

const modules = [createProtectionModule(config), createTicketsModule(config), createAnnouncerModule(config)];

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

client.login(config.token).catch((err) => {
  console.error('Failed to login:', err);
  process.exit(1);
});
