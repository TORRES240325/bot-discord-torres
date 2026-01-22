const express = require('express');
const cors = require('cors');
const path = require('path');
const { PermissionsBitField } = require('discord.js');

function createDashboard(client, config) {
  const app = express();
  const PORT = process.env.PORT || config.dashboardPort || 3000;
  const PASSWORD = config.dashboardPassword || 'admin123';

  app.use(cors());
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    return next();
  });
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // Health check (sin auth) para confirmar que este es el servidor correcto
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      name: 'bot-dashboard',
      port: PORT,
      hasUser: Boolean(client.user),
      guilds: client.guilds?.cache?.size ?? 0,
      endpoints: [
        '/api/login',
        '/api/guilds',
        '/api/guilds/:guildId/channels',
        '/api/guilds/:guildId/roles',
        '/api/guilds/:guildId/categories',
        '/api/tickets/config',
        '/api/tickets/panel',
        '/api/tickets/shop-panel',
      ],
    });
  });

  // Middleware de autenticación simple
  function auth(req, res, next) {
    const token = req.headers['authorization'];
    if (token === PASSWORD) {
      next();
    } else {
      res.status(401).json({ error: 'No autorizado' });
    }
  }

  // Publicar panel tipo tienda: embed + imagen + select de planes
  app.post('/api/tickets/shop-panel', auth, async (req, res) => {
    try {
      const { channelId, embed, plans, placeholder } = req.body;
      const channel = await client.channels.fetch(channelId);
      if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });
      if (!channel.isTextBased()) return res.status(400).json({ error: 'Canal no es de texto' });

      if (!Array.isArray(plans) || plans.length === 0) {
        return res.status(400).json({ error: 'Debes enviar al menos 1 plan' });
      }

      const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

      const eb = new EmbedBuilder();
      if (embed?.title) eb.setTitle(embed.title);
      if (embed?.description) eb.setDescription(embed.description);
      if (embed?.color) eb.setColor(embed.color);
      if (embed?.image) eb.setImage(embed.image);
      if (embed?.thumbnail) eb.setThumbnail(embed.thumbnail);
      if (embed?.footer) eb.setFooter({ text: embed.footer });

      config.ticketPlans = plans.map((p) => ({
        label: p.label,
        value: p.value,
        description: p.description,
        emoji: p.emoji,
      }));

      const menu = new StringSelectMenuBuilder()
        .setCustomId('ticket_plan')
        .setPlaceholder(placeholder || 'Seleccione un Plan')
        .addOptions(
          plans.slice(0, 25).map((p) => ({
            label: (p.label || 'Plan').slice(0, 100),
            value: (p.value || String(Date.now())).slice(0, 100),
            description: p.description ? p.description.slice(0, 100) : undefined,
            emoji: p.emoji || undefined,
          }))
        );

      const row = new ActionRowBuilder().addComponents(menu);

      await channel.send({ embeds: [eb], components: [row] });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Login
  app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === PASSWORD) {
      res.json({ success: true, token: PASSWORD });
    } else {
      res.status(401).json({ error: 'Contraseña incorrecta' });
    }
  });

  // Obtener servidores del bot
  app.get('/api/guilds', auth, (req, res) => {
    const guilds = client.guilds.cache.map(g => ({
      id: g.id,
      name: g.name,
      icon: g.iconURL({ dynamic: true }),
      memberCount: g.memberCount
    }));
    res.json(guilds);
  });

  // Obtener canales de un servidor
  app.get('/api/guilds/:guildId/channels', auth, async (req, res) => {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Servidor no encontrado' });

    // Forzar carga completa (evita que falten canales por cache)
    await guild.channels.fetch().catch(() => null);

    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));

    const typeName = (type) => {
      const map = {
        0: 'text',
        1: 'dm',
        2: 'voice',
        3: 'group_dm',
        4: 'category',
        5: 'announcement',
        10: 'announcement_thread',
        11: 'public_thread',
        12: 'private_thread',
        13: 'stage',
        14: 'directory',
        15: 'forum',
        16: 'media',
      };
      return map[type] || `type_${type}`;
    };

    const channels = guild.channels.cache
      .filter((c) => {
        // Excluir DMs u objetos raros
        if (!('guild' in c) || !c.guild) return false;

        // Solo canales donde el bot pueda ver (si no tenemos me, devolvemos igual)
        if (!me) return true;
        const perms = c.permissionsFor(me);
        return perms?.has(PermissionsBitField.Flags.ViewChannel);
      })
      .map((c) => {
        let canSend = Boolean(c.isTextBased?.());
        if (me) {
          const perms = c.permissionsFor(me);
          canSend = canSend && Boolean(perms?.has(PermissionsBitField.Flags.SendMessages));
        }

        // Nunca se puede "enviar" a categorías / voz / stage
        if ([2, 4, 13].includes(c.type)) canSend = false;

        return {
          id: c.id,
          name: c.name,
          type: c.type,
          typeName: typeName(c.type),
          parentId: c.parentId || null,
          position: c.rawPosition ?? 0,
          canSend,
        };
      })
      .sort((a, b) => {
        // Orden estable por parentId y posición
        const ap = a.parentId || '';
        const bp = b.parentId || '';
        if (ap !== bp) return ap.localeCompare(bp);
        return (a.position ?? 0) - (b.position ?? 0);
      });

    res.json(channels);
  });

  // Obtener roles de un servidor
  app.get('/api/guilds/:guildId/roles', auth, async (req, res) => {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Servidor no encontrado' });

    const roles = guild.roles.cache
      .filter(r => r.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map(r => ({ id: r.id, name: r.name, color: r.hexColor, position: r.position }));
    res.json(roles);
  });

  // Obtener categorías de un servidor
  app.get('/api/guilds/:guildId/categories', auth, async (req, res) => {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Servidor no encontrado' });

    const categories = guild.channels.cache
      .filter(c => c.type === 4)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map(c => ({ id: c.id, name: c.name }));
    res.json(categories);
  });

  // Configurar tickets (usa el mismo config del bot en memoria)
  app.post('/api/tickets/config', auth, async (req, res) => {
    try {
      const { ticketCategoryId, ticketStaffRoleId, logChannelId } = req.body;
      if (!ticketCategoryId || !ticketStaffRoleId) {
        return res.status(400).json({ error: 'ticketCategoryId y ticketStaffRoleId son obligatorios' });
      }

      config.ticketCategoryId = ticketCategoryId;
      config.ticketStaffRoleId = ticketStaffRoleId;
      config.logChannelId = logChannelId || null;

      res.json({
        success: true,
        ticketCategoryId: config.ticketCategoryId,
        ticketStaffRoleId: config.ticketStaffRoleId,
        logChannelId: config.logChannelId,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Publicar panel de tickets en un canal
  app.post('/api/tickets/panel', auth, async (req, res) => {
    try {
      const { channelId, title, description, buttonLabel } = req.body;
      const channel = await client.channels.fetch(channelId);
      if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });
      if (!channel.isTextBased()) return res.status(400).json({ error: 'Canal no es de texto' });

      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

      const embed = new EmbedBuilder()
        .setTitle(title || 'Soporte')
        .setDescription(description || 'Presiona el botón para abrir un ticket.');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_open')
          .setLabel(buttonLabel || 'Abrir ticket')
          .setStyle(ButtonStyle.Primary)
      );

      await channel.send({ embeds: [embed], components: [row] });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Enviar mensaje simple
  app.post('/api/send-message', auth, async (req, res) => {
    try {
      const { channelId, content } = req.body;
      const channel = await client.channels.fetch(channelId);
      if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });

      await channel.send(content);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Enviar embed personalizado
  app.post('/api/send-embed', auth, async (req, res) => {
    try {
      const { channelId, embed, buttons } = req.body;
      const channel = await client.channels.fetch(channelId);
      if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });

      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
      
      const embedBuilder = new EmbedBuilder();
      if (embed.title) embedBuilder.setTitle(embed.title);
      if (embed.description) embedBuilder.setDescription(embed.description);
      if (embed.color) embedBuilder.setColor(embed.color);
      if (embed.image) embedBuilder.setImage(embed.image);
      if (embed.thumbnail) embedBuilder.setThumbnail(embed.thumbnail);
      if (embed.footer) embedBuilder.setFooter({ text: embed.footer });
      if (embed.author) embedBuilder.setAuthor({ name: embed.author });
      if (embed.fields && Array.isArray(embed.fields)) {
        embedBuilder.addFields(embed.fields);
      }
      if (embed.timestamp) embedBuilder.setTimestamp();

      const components = [];
      if (buttons && buttons.length > 0) {
        const row = new ActionRowBuilder();
        for (const btn of buttons.slice(0, 5)) {
          const button = new ButtonBuilder()
            .setLabel(btn.label || 'Botón');
          
          if (btn.url) {
            button.setStyle(ButtonStyle.Link).setURL(btn.url);
          } else {
            button.setStyle(ButtonStyle[btn.style] || ButtonStyle.Primary);
            button.setCustomId(btn.customId || `btn_${Date.now()}_${Math.random()}`);
          }
          if (btn.emoji) button.setEmoji(btn.emoji);
          row.addComponents(button);
        }
        components.push(row);
      }

      await channel.send({ embeds: [embedBuilder], components });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Enviar imagen
  app.post('/api/send-image', auth, async (req, res) => {
    try {
      const { channelId, imageUrl, caption } = req.body;
      const channel = await client.channels.fetch(channelId);
      if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });

      const { EmbedBuilder } = require('discord.js');
      const embed = new EmbedBuilder()
        .setImage(imageUrl)
        .setColor(0x2b2d31);
      
      if (caption) embed.setDescription(caption);

      await channel.send({ embeds: [embed] });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Info del bot
  app.get('/api/bot-info', auth, (req, res) => {
    res.json({
      username: client.user.username,
      avatar: client.user.displayAvatarURL({ dynamic: true }),
      guilds: client.guilds.cache.size,
      users: client.users.cache.size
    });
  });

  function start() {
    app.listen(PORT, () => {
      console.log(`🌐 Dashboard disponible en http://localhost:${PORT}`);
    });
  }

  return { start };
}

module.exports = { createDashboard };
