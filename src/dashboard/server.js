const express = require('express');
const cors = require('cors');
const path = require('path');
const { PermissionsBitField } = require('discord.js');

let firebaseAdmin = null;
let firestoreDb = null;

function getFirestore() {
  if (firestoreDb) return firestoreDb;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;

  try {
    firebaseAdmin = require('firebase-admin');
    const serviceAccount = JSON.parse(raw);

    if (firebaseAdmin.apps.length === 0) {
      firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.cert(serviceAccount),
      });
    }

    firestoreDb = firebaseAdmin.firestore();
    return firestoreDb;
  } catch (err) {
    console.error('Failed to init Firebase Admin:', err);
    return null;
  }
}

function requireFirestore(req, res) {
  const db = getFirestore();
  if (!db) {
    res.status(500).json({ error: 'Firestore no configurado en el backend (FIREBASE_SERVICE_ACCOUNT_JSON)' });
    return null;
  }
  return db;
}

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

  function nowIso() {
    return new Date().toISOString();
  }

  async function writeHistory({ guildId, action, channelId = null, messageId = null, templateId = null, snapshot = null }) {
    const db = getFirestore();
    if (!db) return;
    if (!guildId) return;

    await db.collection('guilds').doc(String(guildId)).collection('history').add({
      action,
      guildId: String(guildId),
      channelId: channelId ? String(channelId) : null,
      messageId: messageId ? String(messageId) : null,
      templateId: templateId ? String(templateId) : null,
      snapshot: snapshot ?? null,
      createdAt: nowIso(),
    });
  }

  function buildComponentsFromButtons(buttons) {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    const components = [];
    if (Array.isArray(buttons) && buttons.length > 0) {
      const row = new ActionRowBuilder();
      for (const btn of buttons.slice(0, 5)) {
        const button = new ButtonBuilder().setLabel(btn.label || 'Botón');
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
    return components;
  }

  function buildEmbedFromData(embed) {
    const { EmbedBuilder } = require('discord.js');
    const eb = new EmbedBuilder();
    if (embed?.title) eb.setTitle(embed.title);
    if (embed?.description) eb.setDescription(embed.description);
    if (embed?.color) eb.setColor(embed.color);
    if (embed?.image) eb.setImage(embed.image);
    if (embed?.thumbnail) eb.setThumbnail(embed.thumbnail);
    if (embed?.footer) eb.setFooter({ text: embed.footer });
    if (embed?.author) eb.setAuthor({ name: embed.author });
    if (embed?.fields && Array.isArray(embed.fields)) eb.addFields(embed.fields);
    if (embed?.timestamp) eb.setTimestamp();
    return eb;
  }

  async function sendFromPayload({ guildId, channelId, payload }) {
    const channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error('Canal no encontrado');
    if (!channel.isTextBased()) throw new Error('Canal no es de texto');

    const type = payload?.type;
    if (type === 'simple') {
      const sent = await channel.send(String(payload.content || ''));
      await writeHistory({ guildId, action: 'publish_simple', channelId, messageId: sent.id, templateId: payload.templateId || null, snapshot: payload });
      return sent;
    }

    if (type === 'embed' || type === 'product') {
      const eb = buildEmbedFromData(payload.embed || {});
      const components = buildComponentsFromButtons(payload.buttons || []);
      const sent = await channel.send({ embeds: [eb], components });
      await writeHistory({ guildId, action: 'publish_embed', channelId, messageId: sent.id, templateId: payload.templateId || null, snapshot: payload });
      return sent;
    }

    if (type === 'image') {
      const { EmbedBuilder } = require('discord.js');
      const embed = new EmbedBuilder().setImage(payload.imageUrl).setColor(0x2b2d31);
      if (payload.caption) embed.setDescription(payload.caption);
      const sent = await channel.send({ embeds: [embed] });
      await writeHistory({ guildId, action: 'publish_image', channelId, messageId: sent.id, templateId: payload.templateId || null, snapshot: payload });
      return sent;
    }

    throw new Error('Tipo de payload no soportado');
  }

  app.get('/api/templates', auth, async (req, res) => {
    try {
      const db = requireFirestore(req, res);
      if (!db) return;

      const guildId = req.query.guildId;
      if (!guildId) return res.status(400).json({ error: 'guildId es obligatorio' });

      const snap = await db.collection('guilds').doc(String(guildId)).collection('templates').orderBy('updatedAt', 'desc').limit(200).get();
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/settings/tickets', auth, async (req, res) => {
    try {
      const db = requireFirestore(req, res);
      if (!db) return;

      const guildId = req.query.guildId;
      if (!guildId) return res.status(400).json({ error: 'guildId es obligatorio' });

      const doc = await db.collection('guilds').doc(String(guildId)).collection('settings').doc('tickets').get();
      const data = doc.exists ? doc.data() : null;
      res.json(data || {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/settings/tickets', auth, async (req, res) => {
    try {
      const db = requireFirestore(req, res);
      if (!db) return;

      const { guildId, settings } = req.body;
      if (!guildId) return res.status(400).json({ error: 'guildId es obligatorio' });
      if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'settings es obligatorio' });

      const payload = {
        ...settings,
        updatedAt: nowIso(),
      };

      await db.collection('guilds').doc(String(guildId)).collection('settings').doc('tickets').set(payload, { merge: true });
      await writeHistory({ guildId, action: 'update_ticket_settings', snapshot: payload });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/templates', auth, async (req, res) => {
    try {
      const db = requireFirestore(req, res);
      if (!db) return;

      const { guildId, name, type, data } = req.body;
      if (!guildId || !name || !type) return res.status(400).json({ error: 'guildId, name y type son obligatorios' });

      const doc = await db.collection('guilds').doc(String(guildId)).collection('templates').add({
        guildId: String(guildId),
        name: String(name),
        type: String(type),
        data: data ?? {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });

      await writeHistory({ guildId, action: 'create_template', templateId: doc.id, snapshot: { name, type } });
      res.json({ success: true, id: doc.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/templates/:id', auth, async (req, res) => {
    try {
      const db = requireFirestore(req, res);
      if (!db) return;

      const templateId = req.params.id;
      const { guildId, name, type, data } = req.body;
      if (!guildId) return res.status(400).json({ error: 'guildId es obligatorio' });

      await db.collection('guilds').doc(String(guildId)).collection('templates').doc(String(templateId)).set({
        guildId: String(guildId),
        name: name != null ? String(name) : undefined,
        type: type != null ? String(type) : undefined,
        data: data != null ? data : undefined,
        updatedAt: nowIso(),
      }, { merge: true });

      await writeHistory({ guildId, action: 'update_template', templateId, snapshot: { name, type } });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/templates/:id', auth, async (req, res) => {
    try {
      const db = requireFirestore(req, res);
      if (!db) return;

      const templateId = req.params.id;
      const guildId = req.query.guildId;
      if (!guildId) return res.status(400).json({ error: 'guildId es obligatorio' });

      await db.collection('guilds').doc(String(guildId)).collection('templates').doc(String(templateId)).delete();
      await writeHistory({ guildId, action: 'delete_template', templateId });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/history', auth, async (req, res) => {
    try {
      const db = requireFirestore(req, res);
      if (!db) return;

      const guildId = req.query.guildId;
      if (!guildId) return res.status(400).json({ error: 'guildId es obligatorio' });

      const snap = await db.collection('guilds').doc(String(guildId)).collection('history').orderBy('createdAt', 'desc').limit(200).get();
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/publish-template', auth, async (req, res) => {
    try {
      const db = requireFirestore(req, res);
      if (!db) return;

      const { guildId, templateId, channelId } = req.body;
      if (!guildId || !templateId || !channelId) return res.status(400).json({ error: 'guildId, templateId y channelId son obligatorios' });

      const doc = await db.collection('guilds').doc(String(guildId)).collection('templates').doc(String(templateId)).get();
      if (!doc.exists) return res.status(404).json({ error: 'Template no encontrado' });
      const tpl = doc.data();

      const payload = {
        type: tpl.type,
        templateId,
        ...tpl.data,
      };

      const sent = await sendFromPayload({ guildId, channelId, payload });
      res.json({ success: true, messageId: sent.id, channelId: String(channelId) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/edit-message', auth, async (req, res) => {
    try {
      const { guildId, channelId, messageId, content, embed, buttons } = req.body;
      if (!guildId || !channelId || !messageId) return res.status(400).json({ error: 'guildId, channelId y messageId son obligatorios' });

      const channel = await client.channels.fetch(channelId);
      if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });
      if (!channel.isTextBased()) return res.status(400).json({ error: 'Canal no es de texto' });

      const msg = await channel.messages.fetch(messageId);
      if (!msg) return res.status(404).json({ error: 'Mensaje no encontrado' });

      const editPayload = {};
      if (content != null) editPayload.content = String(content);
      if (embed != null) editPayload.embeds = [buildEmbedFromData(embed)];
      if (buttons != null) editPayload.components = buildComponentsFromButtons(buttons);

      const edited = await msg.edit(editPayload);
      await writeHistory({ guildId, action: 'edit_message', channelId, messageId, snapshot: { content, embed, buttons } });
      res.json({ success: true, messageId: edited.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

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
      const { channelId, content, guildId } = req.body;
      const channel = await client.channels.fetch(channelId);
      if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });

      const sent = await channel.send(content);
      await writeHistory({ guildId, action: 'publish_simple', channelId, messageId: sent.id, snapshot: { type: 'simple', content } });
      res.json({ success: true, messageId: sent.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Enviar embed personalizado
  app.post('/api/send-embed', auth, async (req, res) => {
    try {
      const { channelId, embed, buttons, guildId } = req.body;
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

      const sent = await channel.send({ embeds: [embedBuilder], components });
      await writeHistory({ guildId, action: 'publish_embed', channelId, messageId: sent.id, snapshot: { type: 'embed', embed, buttons } });
      res.json({ success: true, messageId: sent.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Enviar imagen
  app.post('/api/send-image', auth, async (req, res) => {
    try {
      const { channelId, imageUrl, caption, guildId } = req.body;
      const channel = await client.channels.fetch(channelId);
      if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });

      const { EmbedBuilder } = require('discord.js');
      const embed = new EmbedBuilder()
        .setImage(imageUrl)
        .setColor(0x2b2d31);
      
      if (caption) embed.setDescription(caption);

      const sent = await channel.send({ embeds: [embed] });
      await writeHistory({ guildId, action: 'publish_image', channelId, messageId: sent.id, snapshot: { type: 'image', imageUrl, caption } });
      res.json({ success: true, messageId: sent.id });
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
