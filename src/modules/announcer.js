const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');

function createAnnouncerModule(config) {
  const PREFIX = config.announcerPrefix || '!';
  const ALLOWED_ROLES = config.announcerRoles || [];

  function hasPermission(member) {
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    if (ALLOWED_ROLES.length === 0) return member.permissions.has(PermissionFlagsBits.ManageMessages);
    return member.roles.cache.some(role => ALLOWED_ROLES.includes(role.id));
  }

  async function onMessageCreate(message, client) {
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'anuncio' || command === 'embed') {
      if (!hasPermission(message.member)) {
        return message.reply('❌ No tienes permisos para usar este comando.');
      }

      await message.delete().catch(() => {});

      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle('📢 TÍTULO DEL ANUNCIO')
        .setDescription('Escribe tu descripción aquí.\n\nPuedes usar **negrita**, *cursiva*, y emojis 🎮')
        .addFields(
          { name: '💰 PRECIOS', value: '• Opción 1: $5.00\n• Opción 2: $10.00', inline: false },
          { name: '📋 INFORMACIÓN', value: 'Más detalles aquí...', inline: false }
        )
        .setImage('https://i.imgur.com/placeholder.png')
        .setThumbnail(message.guild.iconURL({ dynamic: true }))
        .setFooter({ text: 'Tu servidor', iconURL: message.guild.iconURL({ dynamic: true }) })
        .setTimestamp();

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('ticket_create')
            .setLabel('🎫 TICKET')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('info_btn')
            .setLabel('ℹ️ INFO')
            .setStyle(ButtonStyle.Secondary)
        );

      await message.channel.send({ embeds: [embed], components: [row] });
    }

    if (command === 'enviar') {
      if (!hasPermission(message.member)) {
        return message.reply('❌ No tienes permisos para usar este comando.');
      }

      const texto = args.join(' ');
      if (!texto) {
        return message.reply('❌ Uso: `!enviar <mensaje>`');
      }

      await message.delete().catch(() => {});
      await message.channel.send(texto);
    }

    if (command === 'embedcustom') {
      if (!hasPermission(message.member)) {
        return message.reply('❌ No tienes permisos para usar este comando.');
      }

      await message.delete().catch(() => {});

      const jsonMatch = message.content.match(/```json\n?([\s\S]*?)```/);
      if (!jsonMatch) {
        return message.channel.send('❌ Uso: `!embedcustom` seguido de un bloque JSON:\n```json\n{\n  "title": "Título",\n  "description": "Descripción",\n  "color": "#00ff00",\n  "image": "URL",\n  "thumbnail": "URL",\n  "fields": [{"name": "Campo", "value": "Valor"}]\n}\n```');
      }

      try {
        const data = JSON.parse(jsonMatch[1]);
        const embed = new EmbedBuilder();

        if (data.title) embed.setTitle(data.title);
        if (data.description) embed.setDescription(data.description);
        if (data.color) embed.setColor(data.color);
        if (data.image) embed.setImage(data.image);
        if (data.thumbnail) embed.setThumbnail(data.thumbnail);
        if (data.footer) embed.setFooter({ text: data.footer });
        if (data.fields && Array.isArray(data.fields)) {
          embed.addFields(data.fields.map(f => ({
            name: f.name || 'Campo',
            value: f.value || 'Valor',
            inline: f.inline || false
          })));
        }
        if (data.timestamp) embed.setTimestamp();

        const components = [];
        if (data.buttons && Array.isArray(data.buttons)) {
          const row = new ActionRowBuilder();
          for (const btn of data.buttons.slice(0, 5)) {
            const button = new ButtonBuilder()
              .setLabel(btn.label || 'Botón')
              .setStyle(ButtonStyle[btn.style] || ButtonStyle.Primary);
            
            if (btn.url) {
              button.setStyle(ButtonStyle.Link).setURL(btn.url);
            } else {
              button.setCustomId(btn.customId || `btn_${Date.now()}`);
            }
            if (btn.emoji) button.setEmoji(btn.emoji);
            row.addComponents(button);
          }
          components.push(row);
        }

        await message.channel.send({ embeds: [embed], components });
      } catch (err) {
        await message.channel.send(`❌ Error en el JSON: ${err.message}`);
      }
    }

    if (command === 'imagen') {
      if (!hasPermission(message.member)) {
        return message.reply('❌ No tienes permisos para usar este comando.');
      }

      const url = args[0];
      if (!url) {
        return message.reply('❌ Uso: `!imagen <URL>`');
      }

      await message.delete().catch(() => {});

      const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setImage(url);

      await message.channel.send({ embeds: [embed] });
    }

    if (command === 'producto') {
      if (!hasPermission(message.member)) {
        return message.reply('❌ No tienes permisos para usar este comando.');
      }

      await message.delete().catch(() => {});

      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setAuthor({ 
          name: message.guild.name, 
          iconURL: message.guild.iconURL({ dynamic: true }) 
        })
        .setTitle('🎮 NOMBRE DEL PRODUCTO')
        .setDescription(
          'Descripción detallada del producto aquí.\n\n' +
          'Características:\n' +
          '• ✅ Característica 1\n' +
          '• ✅ Característica 2\n' +
          '• ✅ Característica 3\n\n' +
          '─────────────────────────────────'
        )
        .addFields(
          { name: '💰 PRECIOS:', value: '• Día: S/. 3.00 - $5.00\n• Mensual: S/. 45.00 - $15.00', inline: false },
          { name: '📩 ADQUIRIR:', value: 'Para adquirir nuestro producto, abre un 🎫 **TICKET**', inline: false }
        )
        .setImage('https://i.imgur.com/placeholder.png')
        .setFooter({ 
          text: '✅ TODO PRODUCTO SALE CON GARANTÍA Y SEGURIDAD', 
          iconURL: message.guild.iconURL({ dynamic: true }) 
        })
        .setTimestamp();

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('ticket_create')
            .setLabel('🎫 TICKET')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('producto_info')
            .setLabel('📋 MÁS INFO')
            .setStyle(ButtonStyle.Primary)
        );

      await message.channel.send({ embeds: [embed], components: [row] });
    }

    if (command === 'ayuda' || command === 'help') {
      const helpEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📚 Comandos de Anuncios')
        .setDescription('Lista de comandos disponibles:')
        .addFields(
          { name: `${PREFIX}anuncio`, value: 'Envía un embed de anuncio predeterminado', inline: false },
          { name: `${PREFIX}producto`, value: 'Envía un embed estilo producto/venta', inline: false },
          { name: `${PREFIX}enviar <texto>`, value: 'Envía un mensaje de texto simple', inline: false },
          { name: `${PREFIX}imagen <URL>`, value: 'Envía una imagen en un embed', inline: false },
          { name: `${PREFIX}embedcustom`, value: 'Crea un embed personalizado con JSON', inline: false }
        )
        .setFooter({ text: 'Usa los comandos para personalizar tus anuncios' });

      await message.reply({ embeds: [helpEmbed] });
    }
  }

  return {
    name: 'announcer',
    onMessageCreate,
  };
}

module.exports = { createAnnouncerModule };
