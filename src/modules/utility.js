const { SlashCommandBuilder } = require('discord.js');

const startedAt = Date.now();

function createUtilityModule(config) {
  const commands = [
    new SlashCommandBuilder().setName('ping').setDescription('Ver latencia del bot'),
    new SlashCommandBuilder().setName('uptime').setDescription('Tiempo encendido del bot'),
    new SlashCommandBuilder().setName('serverinfo').setDescription('Información del servidor'),
    new SlashCommandBuilder()
      .setName('userinfo')
      .setDescription('Información de un usuario')
      .addUserOption((o) => o.setName('user').setDescription('Usuario (opcional)')),
    new SlashCommandBuilder()
      .setName('avatar')
      .setDescription('Ver avatar de un usuario')
      .addUserOption((o) => o.setName('user').setDescription('Usuario (opcional)')),
    new SlashCommandBuilder().setName('help').setDescription('Lista de comandos principales'),
  ];

  function formatDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    parts.push(`${ss}s`);
    return parts.join(' ');
  }

  return {
    name: 'utility',
    getSlashCommands() {
      return commands;
    },
    async onInteractionCreate(interaction, client) {
      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === 'ping') {
        const ws = client.ws.ping;
        await interaction.reply({ content: `🏓 Pong. WS: ${ws}ms`, ephemeral: false });
        return;
      }

      if (interaction.commandName === 'uptime') {
        const up = formatDuration(Date.now() - startedAt);
        await interaction.reply({ content: `⏱️ Uptime: ${up}`, ephemeral: false });
        return;
      }

      if (interaction.commandName === 'serverinfo') {
        const g = interaction.guild;
        if (!g) return;
        const created = Math.floor(g.createdTimestamp / 1000);
        await interaction.reply({
          content: `🏠 **${g.name}**\nID: ${g.id}\nMiembros: ${g.memberCount}\nCreado: <t:${created}:F>`,
          ephemeral: false,
        });
        return;
      }

      if (interaction.commandName === 'userinfo') {
        const u = interaction.options.getUser('user') || interaction.user;
        const created = Math.floor(u.createdTimestamp / 1000);
        await interaction.reply({
          content: `👤 **${u.tag}**\nID: ${u.id}\nCreado: <t:${created}:F>`,
          ephemeral: false,
        });
        return;
      }

      if (interaction.commandName === 'avatar') {
        const u = interaction.options.getUser('user') || interaction.user;
        const url = u.displayAvatarURL({ size: 1024 });
        await interaction.reply({ content: url, ephemeral: false });
        return;
      }

      if (interaction.commandName === 'help') {
        const txt = [
          '**Comandos principales:**',
          '- `/join` unir bot a voz (se queda)',
          '- `/leave` sacar bot de voz',
          '- `/play <link o búsqueda>` reproducir',
          '- `/stop` parar y limpiar cola',
          '- `/skip` saltar',
          '- `/queue` ver cola',
          '- `/tts on|off` leer mensajes (mismo voice)',
          '',
          '**Utilidad:**',
          '- `/ping`',
          '- `/uptime`',
          '- `/serverinfo`',
          '- `/userinfo`',
          '- `/avatar`',
        ].join('\n');
        await interaction.reply({ content: txt, ephemeral: false });
      }
    },
  };
}

module.exports = {
  createUtilityModule,
};
