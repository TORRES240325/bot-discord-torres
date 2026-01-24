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
  app.use(express.static(path.join(__dirname, 'public'), { index: false }));

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  });

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

  function applyWelcomePlaceholders(text, vars) {
    if (text == null) return '';
    return String(text)
      .replaceAll('{user}', vars.user)
      .replaceAll('{userId}', vars.userId)
      .replaceAll('{mention}', vars.mention)
      .replaceAll('{guildName}', vars.guildName)
      .replaceAll('{guildId}', vars.guildId)
      .replaceAll('{memberCount}', vars.memberCount);
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

  function safeName(name) {
    return String(name || '').trim().slice(0, 96);
  }

  function normalizeSlug(name) {
    return safeName(name)
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90);
  }

  function buildDefaultStructure() {
    return {
      categories: [
        { key: 'inicio', name: 'INICIO' },
        { key: 'soporte', name: 'SOPORTE' },
        { key: 'store', name: 'STORE' },
        { key: 'tickets', name: 'TICKETS' },
        { key: 'logs', name: 'LOGS' },
      ],
      channels: [
        { key: 'reglas', name: '📌・reglas', categoryKey: 'inicio' },
        { key: 'server', name: '🔎・server', categoryKey: 'inicio' },
        { key: 'ticket', name: '🎫・ticket', categoryKey: 'soporte' },
        { key: 'metodos_pago', name: '🛒・metodos-de-pago', categoryKey: 'soporte' },
        { key: 'panel_supreme', name: '🟩・panel-supreme', categoryKey: 'store' },
        { key: 'panel_bypass', name: '🟩・panel-bypass', categoryKey: 'store' },
        { key: 'logs', name: '📜・logs', categoryKey: 'logs' },
      ],
      roles: [
        { key: 'owner', name: 'OWNER', color: '#ff2d2d' },
        { key: 'admin', name: 'ADMIN', color: '#ff4d6d' },
        { key: 'mod', name: 'MOD', color: '#f97316' },
        { key: 'staff', name: 'STAFF', color: '#22c55e' },
        { key: 'soporte', name: 'SOPORTE', color: '#3b82f6' },
        { key: 'vip', name: 'VIP', color: '#a855f7' },
      ],
    };
  }

  function asPermOverwrite({ id, allow = [], deny = [] }) {
    const { PermissionsBitField } = require('discord.js');
    return {
      id,
      allow: new PermissionsBitField(allow).bitfield,
      deny: new PermissionsBitField(deny).bitfield,
    };
  }

  async function resolveGuild(guildId) {
    const guild = client.guilds.cache.get(String(guildId));
    if (!guild) return null;
    await guild.channels.fetch().catch(() => null);
    await guild.roles.fetch().catch(() => null);
    return guild;
  }

  function getMe(guild) {
    return guild.members.me;
  }

  function ensureBotPermissionsOrThrow(guild, needed) {
    const me = getMe(guild);
    if (!me) throw new Error('No se pudo obtener el miembro del bot en el servidor');
    const missing = needed.filter((p) => !me.permissions.has(p));
    if (missing.length) {
      throw new Error('Al bot le faltan permisos: ' + missing.join(', '));
    }
  }

  async function planSetup(guildId) {
    const guild = await resolveGuild(guildId);
    if (!guild) throw new Error('Servidor no encontrado');

    const spec = buildDefaultStructure();

    const existingCategoriesByKey = {};
    for (const c of spec.categories) {
      const found = guild.channels.cache.find((ch) => ch.type === 4 && (ch.name || '').toLowerCase() === c.name.toLowerCase());
      if (found) existingCategoriesByKey[c.key] = found.id;
    }

    const existingRolesByKey = {};
    for (const r of spec.roles) {
      const found = guild.roles.cache.find((role) => (role.name || '').toLowerCase() === r.name.toLowerCase());
      if (found) existingRolesByKey[r.key] = found.id;
    }

    const existingChannelsByKey = {};
    for (const ch of spec.channels) {
      const found = guild.channels.cache.find((c) => c.type === 0 && (c.name || '').toLowerCase() === normalizeSlug(ch.name));
      if (found) existingChannelsByKey[ch.key] = found.id;
    }

    const actions = [];
    for (const c of spec.categories) {
      actions.push({ type: 'category', key: c.key, name: c.name, exists: Boolean(existingCategoriesByKey[c.key]) });
    }
    for (const r of spec.roles) {
      actions.push({ type: 'role', key: r.key, name: r.name, exists: Boolean(existingRolesByKey[r.key]) });
    }
    for (const ch of spec.channels) {
      actions.push({ type: 'channel', key: ch.key, name: ch.name, categoryKey: ch.categoryKey, exists: Boolean(existingChannelsByKey[ch.key]) });
    }

    return {
      guildId: String(guildId),
      spec,
      existing: {
        categories: existingCategoriesByKey,
        roles: existingRolesByKey,
        channels: existingChannelsByKey,
      },
      actions,
    };
  }

  async function applySetup({ guildId }) {
    const guild = await resolveGuild(guildId);
    if (!guild) throw new Error('Servidor no encontrado');

    ensureBotPermissionsOrThrow(guild, [
      PermissionsBitField.Flags.ManageChannels,
      PermissionsBitField.Flags.ManageRoles,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.ViewChannel,
    ]);

    const plan = await planSetup(guildId);
    const spec = plan.spec;
    const created = { categories: {}, roles: {}, channels: {}, published: {} };

    // Roles
    for (const r of spec.roles) {
      const existingId = plan.existing.roles[r.key];
      if (existingId) {
        created.roles[r.key] = existingId;
        continue;
      }
      const role = await guild.roles.create({
        name: safeName(r.name),
        color: r.color || undefined,
        reason: 'Setup rápido (dashboard)',
      });
      created.roles[r.key] = role.id;
    }

    // Categories
    for (const c of spec.categories) {
      const existingId = plan.existing.categories[c.key];
      if (existingId) {
        created.categories[c.key] = existingId;
        continue;
      }

      let permissionOverwrites = undefined;
      if (c.key === 'logs') {
        const staffRoleId = created.roles.staff || plan.existing.roles.staff;
        permissionOverwrites = [
          asPermOverwrite({ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }),
          ...(staffRoleId ? [asPermOverwrite({ id: staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel] })] : []),
        ];
      }

      const category = await guild.channels.create({
        name: safeName(c.name),
        type: 4,
        permissionOverwrites,
        reason: 'Setup rápido (dashboard)',
      });
      created.categories[c.key] = category.id;
    }

    // Channels
    for (const ch of spec.channels) {
      const existingId = plan.existing.channels[ch.key];
      if (existingId) {
        created.channels[ch.key] = existingId;
        continue;
      }

      const parentId = created.categories[ch.categoryKey] || plan.existing.categories[ch.categoryKey] || null;
      let permissionOverwrites = undefined;
      if (ch.key === 'logs') {
        const staffRoleId = created.roles.staff || plan.existing.roles.staff;
        permissionOverwrites = [
          asPermOverwrite({ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }),
          ...(staffRoleId ? [asPermOverwrite({ id: staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] })] : []),
        ];
      }

      const channel = await guild.channels.create({
        name: normalizeSlug(ch.name),
        type: 0,
        parent: parentId || undefined,
        permissionOverwrites,
        reason: 'Setup rápido (dashboard)',
      });
      created.channels[ch.key] = channel.id;
    }

    // Publicar mensajes base (en reglas/server)
    const rulesChannelId = created.channels.reglas || plan.existing.channels.reglas;
    if (rulesChannelId) {
      const payload = {
        type: 'embed',
        embed: {
          title: '📌 Reglas del Servidor',
          description: '1) Respeta a todos\n2) No spam\n3) No links sin permiso\n4) Usa tickets para soporte',
          color: '#ff2d2d',
          footer: 'Dashboard Setup',
        }
      };
      const sent = await sendFromPayload({ guildId, channelId: rulesChannelId, payload });
      created.published.reglas = { channelId: rulesChannelId, messageId: sent.id };
    }

    const serverChannelId = created.channels.server || plan.existing.channels.server;
    if (serverChannelId) {
      const payload = {
        type: 'embed',
        embed: {
          title: '🔎 Información',
          description: 'Canales importantes:\n- #reglas\n- #ticket\n- #metodos-de-pago\n- #panel-supreme\n\nBienvenido!',
          color: '#ff2d2d',
          footer: 'Dashboard Setup',
        }
      };
      const sent = await sendFromPayload({ guildId, channelId: serverChannelId, payload });
      created.published.server = { channelId: serverChannelId, messageId: sent.id };
    }

    const db = getFirestore();
    if (db) {
      const snapshot = {
        created,
        appliedAt: nowIso(),
      };
      await db.collection('guilds').doc(String(guildId)).collection('settings').doc('setup').set(snapshot, { merge: true });
      await writeHistory({ guildId, action: 'setup_apply', snapshot });
    }

    return created;
  }

  app.post('/api/setup/plan', auth, async (req, res) => {
    try {
      const { guildId } = req.body;
      if (!guildId) return res.status(400).json({ error: 'guildId es obligatorio' });
      const plan = await planSetup(guildId);
      res.json({ success: true, plan });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/healthcheck/guild', auth, async (req, res) => {
    try {
      const db = requireFirestore(req, res);
      if (!db) return;

      const guildId = req.query.guildId;
      if (!guildId) return res.status(400).json({ error: 'guildId es obligatorio' });

      const docs = await Promise.all([
        db.collection('guilds').doc(String(guildId)).collection('settings').doc('setup').get(),
        db.collection('guilds').doc(String(guildId)).collection('settings').doc('tickets').get(),
        db.collection('guilds').doc(String(guildId)).collection('settings').doc('welcome').get(),
        db.collection('guilds').doc(String(guildId)).collection('settings').doc('moderation').get(),
        db.collection('guilds').doc(String(guildId)).collection('settings').doc('logs').get(),
        db.collection('guilds').doc(String(guildId)).collection('settings').doc('verify').get(),
      ]);

      const [setup, tickets, welcome, moderation, logs, verify] = docs;

      res.json({
        guildId: String(guildId),
        setup: setup.exists,
        tickets: tickets.exists,
        welcome: welcome.exists,
        moderation: moderation.exists,
        logs: logs.exists,
        verify: verify.exists,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/settings/raid', auth, async (req, res) => {
    try {
      const db = requireFirestore(req, res);
      if (!db) return;

      const guildId = req.query.guildId;
      if (!guildId) return res.status(400).json({ error: 'guildId es obligatorio' });

      const doc = await db.collection('guilds').doc(String(guildId)).collection('settings').doc('raid').get();
      const data = doc.exists ? doc.data() : null;
      res.json(data || {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/settings/raid', auth, async (req, res) => {
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

      await db.collection('guilds').doc(String(guildId)).collection('settings').doc('raid').set(payload, { merge: true });
      await writeHistory({ guildId, action: 'update_raid_settings', snapshot: payload });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/onboarding/panel', auth, async (req, res) => {
    try {
      const { guildId, channelId } = req.body;
      if (!guildId || !channelId) return res.status(400).json({ error: 'guildId y channelId son obligatorios' });

      const channel = await client.channels.fetch(channelId);
      if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });
      if (!channel.isTextBased()) return res.status(400).json({ error: 'Canal no es de texto' });

      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
      const embed = new EmbedBuilder()
        .setTitle('BIENVENIDO')
        .setDescription('Usa estos botones para navegar por el servidor.')
        .setColor('#ff2d2d');

      // Botones por defecto (se pueden editar usando el editor de mensajes luego)
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Secondary).setCustomId('noop_rules').setLabel('📌 Reglas'),
        new ButtonBuilder().setStyle(ButtonStyle.Secondary).setCustomId('noop_server').setLabel('🔎 Server'),
        new ButtonBuilder().setStyle(ButtonStyle.Secondary).setCustomId('noop_ticket').setLabel('🎫 Ticket'),
        new ButtonBuilder().setStyle(ButtonStyle.Secondary).setCustomId('noop_store').setLabel('🛒 Store'),
      );

      const sent = await channel.send({ embeds: [embed], components: [row] });
      await writeHistory({ guildId, action: 'publish_onboarding_panel', channelId, messageId: sent.id, snapshot: { type: 'onboarding' } });
      res.json({ success: true, messageId: sent.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/setup/configure-all', auth, async (req, res) => {
    try {
      const db = requireFirestore(req, res);
      if (!db) return;

      const { guildId, publishChannelId } = req.body;
      if (!guildId) return res.status(400).json({ error: 'guildId es obligatorio' });

      // 1) Setup
      const created = await applySetup({ guildId });

      // 2) Guardar presets recomendados en Firestore
      const logChannelId = (created.channels.logs || null);
      const staffRoleId = (created.roles.staff || null);

      const moderationSettings = {
        enabled: true,
        blockLinks: true,
        blockInvites: true,
        spamEnabled: true,
        spamWindowMs: 7000,
        spamMaxMsgs: 6,
        spamTimeoutMs: 60000,
        whitelistDomains: ['discord.com', 'youtube.com', 'github.com'],
        exemptRoleIds: staffRoleId ? [staffRoleId] : [],
        exemptChannelIds: [],
        logChannelId: logChannelId || null,
        updatedAt: nowIso(),
      };

      const logsSettings = {
        enabled: true,
        channelId: logChannelId || null,
        logMessageDelete: true,
        logMessageEdit: true,
        logJoins: true,
        logLeaves: true,
        updatedAt: nowIso(),
      };

      const verifySettings = {
        enabled: true,
        roleId: null,
        autoRoleId: null,
        panelTitle: '✅ Verificación',
        panelDescription: 'Presiona el botón para verificarte.',
        panelColor: '#ff2d2d',
        buttonLabel: 'Verificarme',
        updatedAt: nowIso(),
      };

      const raidSettings = {
        enabled: true,
        joinWindowMs: 15000,
        joinThreshold: 8,
        defenseDurationMs: 300000,
        slowmodeSeconds: 10,
        lockLinks: true,
        logChannelId: logChannelId || null,
        updatedAt: nowIso(),
      };

      await Promise.all([
        db.collection('guilds').doc(String(guildId)).collection('settings').doc('moderation').set(moderationSettings, { merge: true }),
        db.collection('guilds').doc(String(guildId)).collection('settings').doc('logs').set(logsSettings, { merge: true }),
        db.collection('guilds').doc(String(guildId)).collection('settings').doc('verify').set(verifySettings, { merge: true }),
        db.collection('guilds').doc(String(guildId)).collection('settings').doc('raid').set(raidSettings, { merge: true }),
      ]);

      // 3) Publicar paneles (si el usuario seleccionó canal)
      let verifyPanel = null;
      let onboardingPanel = null;

      if (publishChannelId) {
        // verify panel
        const ch = await client.channels.fetch(publishChannelId);
        if (ch && ch.isTextBased()) {
          const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
          const embed = new EmbedBuilder()
            .setTitle('✅ Verificación')
            .setDescription('Presiona el botón para verificarte.')
            .setColor('#ff2d2d');
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('verify_me').setLabel('Verificarme').setStyle(ButtonStyle.Success)
          );
          const sent = await ch.send({ embeds: [embed], components: [row] });
          verifyPanel = { channelId: String(publishChannelId), messageId: sent.id };

          const embed2 = new EmbedBuilder()
            .setTitle('BIENVENIDO')
            .setDescription('Usa estos botones para navegar por el servidor.')
            .setColor('#ff2d2d');
          const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Secondary).setCustomId('noop_rules').setLabel('📌 Reglas'),
            new ButtonBuilder().setStyle(ButtonStyle.Secondary).setCustomId('noop_server').setLabel('🔎 Server'),
            new ButtonBuilder().setStyle(ButtonStyle.Secondary).setCustomId('noop_ticket').setLabel('🎫 Ticket'),
            new ButtonBuilder().setStyle(ButtonStyle.Secondary).setCustomId('noop_store').setLabel('🛒 Store'),
          );
          const sent2 = await ch.send({ embeds: [embed2], components: [row2] });
          onboardingPanel = { channelId: String(publishChannelId), messageId: sent2.id };
        }
      }

      await writeHistory({ guildId, action: 'configure_all', snapshot: { created, verifyPanel, onboardingPanel } });
      res.json({ success: true, created, verifyPanel, onboardingPanel });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/backup/export', auth, async (req, res) => {
    try {
      const db = requireFirestore(req, res);
      if (!db) return;

      const guildId = req.query.guildId;
      if (!guildId) return res.status(400).json({ error: 'guildId es obligatorio' });

      const [setup, tickets, welcome, moderation, logs, verify, templatesSnap] = await Promise.all([
        db.collection('guilds').doc(String(guildId)).collection('settings').doc('setup').get(),
        db.collection('guilds').doc(String(guildId)).collection('settings').doc('tickets').get(),
        db.collection('guilds').doc(String(guildId)).collection('settings').doc('welcome').get(),
        db.collection('guilds').doc(String(guildId)).collection('settings').doc('moderation').get(),
        db.collection('guilds').doc(String(guildId)).collection('settings').doc('logs').get(),
        db.collection('guilds').doc(String(guildId)).collection('settings').doc('verify').get(),
        db.collection('guilds').doc(String(guildId)).collection('templates').limit(200).get(),
      ]);

      const exportData = {
        guildId: String(guildId),
        exportedAt: nowIso(),
        settings: {
          setup: setup.exists ? (setup.data() || {}) : {},
          tickets: tickets.exists ? (tickets.data() || {}) : {},
          welcome: welcome.exists ? (welcome.data() || {}) : {},
          moderation: moderation.exists ? (moderation.data() || {}) : {},
          logs: logs.exists ? (logs.data() || {}) : {},
          verify: verify.exists ? (verify.data() || {}) : {},
        },
        templates: templatesSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      };

      await db.collection('guilds').doc(String(guildId)).collection('backups').add({
        createdAt: nowIso(),
        export: exportData,
      });
      await writeHistory({ guildId, action: 'backup_export', snapshot: { countTemplates: exportData.templates.length } });

      res.json({ success: true, export: exportData });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/backup/import', auth, async (req, res) => {
    try {
      const db = requireFirestore(req, res);
      if (!db) return;

      const { guildId, exportData } = req.body;
      if (!guildId) return res.status(400).json({ error: 'guildId es obligatorio' });
      if (!exportData || typeof exportData !== 'object') return res.status(400).json({ error: 'exportData es obligatorio' });

      const settings = exportData.settings || {};
      const targetGuildId = String(guildId);

      const writes = [];
      for (const key of ['setup', 'tickets', 'welcome', 'moderation', 'logs', 'verify']) {
        const docData = settings[key];
        if (docData && typeof docData === 'object') {
          writes.push(db.collection('guilds').doc(targetGuildId).collection('settings').doc(key).set({
            ...docData,
            importedAt: nowIso(),
            updatedAt: nowIso(),
          }, { merge: true }));
        }
      }

      // templates: upsert by name+type (simple), otherwise create new
      const templates = Array.isArray(exportData.templates) ? exportData.templates : [];
      for (const tpl of templates.slice(0, 200)) {
        const name = tpl.name;
        const type = tpl.type;
        if (!name || !type) continue;
        writes.push(db.collection('guilds').doc(targetGuildId).collection('templates').add({
          guildId: targetGuildId,
          name: String(name),
          type: String(type),
          data: tpl.data ?? {},
          createdAt: nowIso(),
          updatedAt: nowIso(),
          importedFromGuildId: exportData.guildId || null,
        }));
      }

      await Promise.all(writes);

      await db.collection('guilds').doc(targetGuildId).collection('backups').add({
        createdAt: nowIso(),
        importedFrom: exportData.guildId || null,
        export: exportData,
      });

      await writeHistory({ guildId: targetGuildId, action: 'backup_import', snapshot: { importedTemplates: templates.length } });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/settings/moderation', auth, async (req, res) => {
    try {
      const db = requireFirestore(req, res);
      if (!db) return;

      const guildId = req.query.guildId;
      if (!guildId) return res.status(400).json({ error: 'guildId es obligatorio' });

      const doc = await db.collection('guilds').doc(String(guildId)).collection('settings').doc('moderation').get();
      const data = doc.exists ? doc.data() : null;
      res.json(data || {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/settings/moderation', auth, async (req, res) => {
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

      await db.collection('guilds').doc(String(guildId)).collection('settings').doc('moderation').set(payload, { merge: true });
      await writeHistory({ guildId, action: 'update_moderation_settings', snapshot: payload });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/settings/logs', auth, async (req, res) => {
    try {
      const db = requireFirestore(req, res);
      if (!db) return;

      const guildId = req.query.guildId;
      if (!guildId) return res.status(400).json({ error: 'guildId es obligatorio' });

      const doc = await db.collection('guilds').doc(String(guildId)).collection('settings').doc('logs').get();
      const data = doc.exists ? doc.data() : null;
      res.json(data || {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/settings/logs', auth, async (req, res) => {
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

      await db.collection('guilds').doc(String(guildId)).collection('settings').doc('logs').set(payload, { merge: true });
      await writeHistory({ guildId, action: 'update_logs_settings', snapshot: payload });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/settings/verify', auth, async (req, res) => {
    try {
      const db = requireFirestore(req, res);
      if (!db) return;

      const guildId = req.query.guildId;
      if (!guildId) return res.status(400).json({ error: 'guildId es obligatorio' });

      const doc = await db.collection('guilds').doc(String(guildId)).collection('settings').doc('verify').get();
      const data = doc.exists ? doc.data() : null;
      res.json(data || {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/settings/verify', auth, async (req, res) => {
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

      await db.collection('guilds').doc(String(guildId)).collection('settings').doc('verify').set(payload, { merge: true });
      await writeHistory({ guildId, action: 'update_verify_settings', snapshot: payload });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/verify/panel', auth, async (req, res) => {
    try {
      const { guildId, channelId } = req.body;
      if (!guildId || !channelId) return res.status(400).json({ error: 'guildId y channelId son obligatorios' });

      const db = requireFirestore(req, res);
      if (!db) return;

      const doc = await db.collection('guilds').doc(String(guildId)).collection('settings').doc('verify').get();
      const settings = doc.exists ? (doc.data() || {}) : {};

      const channel = await client.channels.fetch(channelId);
      if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });
      if (!channel.isTextBased()) return res.status(400).json({ error: 'Canal no es de texto' });

      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
      const embed = new EmbedBuilder()
        .setTitle(String(settings.panelTitle || '✅ Verificación').slice(0, 256))
        .setDescription(String(settings.panelDescription || 'Presiona el botón para verificarte.').slice(0, 4096))
        .setColor(settings.panelColor || '#ff2d2d');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('verify_me')
          .setLabel(String(settings.buttonLabel || 'Verificarme').slice(0, 80))
          .setStyle(ButtonStyle.Success)
      );

      const sent = await channel.send({ embeds: [embed], components: [row] });
      await writeHistory({ guildId, action: 'publish_verify_panel', channelId, messageId: sent.id, snapshot: settings });
      res.json({ success: true, messageId: sent.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/setup/apply', auth, async (req, res) => {
    try {
      const { guildId } = req.body;
      if (!guildId) return res.status(400).json({ error: 'guildId es obligatorio' });
      const created = await applySetup({ guildId });
      res.json({ success: true, created });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

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

  app.get('/api/settings/welcome', auth, async (req, res) => {
    try {
      const db = requireFirestore(req, res);
      if (!db) return;

      const guildId = req.query.guildId;
      if (!guildId) return res.status(400).json({ error: 'guildId es obligatorio' });

      const doc = await db.collection('guilds').doc(String(guildId)).collection('settings').doc('welcome').get();
      const data = doc.exists ? doc.data() : null;
      res.json(data || {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/settings/welcome', auth, async (req, res) => {
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

      await db.collection('guilds').doc(String(guildId)).collection('settings').doc('welcome').set(payload, { merge: true });
      await writeHistory({ guildId, action: 'update_welcome_settings', snapshot: payload });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/welcome/publish', auth, async (req, res) => {
    try {
      const { guildId, channelId } = req.body;
      if (!guildId || !channelId) return res.status(400).json({ error: 'guildId y channelId son obligatorios' });

      const db = requireFirestore(req, res);
      if (!db) return;

      const doc = await db.collection('guilds').doc(String(guildId)).collection('settings').doc('welcome').get();
      if (!doc.exists) return res.status(404).json({ error: 'No hay configuración de bienvenida guardada' });
      const settings = doc.data() || {};

      const channel = await client.channels.fetch(channelId);
      if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });
      if (!channel.isTextBased()) return res.status(400).json({ error: 'Canal no es de texto' });

      const vars = {
        user: 'NuevoUsuario',
        userId: '000000000000000000',
        mention: '@NuevoUsuario',
        guildName: 'TuServidor',
        guildId: String(guildId),
        memberCount: String(channel.guild?.memberCount ?? ''),
      };

      const contentParts = [];
      if (settings.pingUser) contentParts.push(String(vars.mention));
      if (settings.content) contentParts.push(applyWelcomePlaceholders(settings.content, vars));
      const content = contentParts.join(' ').trim();

      const payload = {};
      if (content) payload.content = content;
      if (settings.embed) {
        const embed = { ...settings.embed };
        if (embed.title) embed.title = applyWelcomePlaceholders(embed.title, vars);
        if (embed.description) embed.description = applyWelcomePlaceholders(embed.description, vars);
        if (embed.footer) embed.footer = applyWelcomePlaceholders(embed.footer, vars);
        if (Array.isArray(embed.fields)) {
          embed.fields = embed.fields.map((f) => ({
            ...f,
            name: applyWelcomePlaceholders(f.name, vars),
            value: applyWelcomePlaceholders(f.value, vars),
          }));
        }
        payload.embeds = [buildEmbedFromData(embed)];
      }
      if (settings.buttons) {
        const buttons = (settings.buttons || []).map((b) => ({
          ...b,
          label: applyWelcomePlaceholders(b.label || 'Botón', vars),
        }));
        payload.components = buildComponentsFromButtons(buttons);
      }

      if (!payload.content && (!payload.embeds || payload.embeds.length === 0)) {
        return res.status(400).json({ error: 'La configuración no tiene content ni embed' });
      }

      const sent = await channel.send(payload);
      await writeHistory({ guildId, action: 'publish_welcome_preview', channelId, messageId: sent.id, snapshot: settings });
      res.json({ success: true, messageId: sent.id });
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

  // Publicar panel de tickets de soporte en un canal
  app.post('/api/tickets/support-panel', auth, async (req, res) => {
    try {
      const { channelId, title, description, buttonLabel } = req.body;
      const channel = await client.channels.fetch(channelId);
      if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });
      if (!channel.isTextBased()) return res.status(400).json({ error: 'Canal no es de texto' });

      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

      const embed = new EmbedBuilder()
        .setTitle(title || 'Soporte Técnico')
        .setDescription(description || '¿Necesitas ayuda? Abre un ticket y nuestro equipo te asistirá.')
        .setColor('#ff2d2d');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('support_ticket_open')
          .setLabel(buttonLabel || 'Abrir Ticket de Soporte')
          .setStyle(ButtonStyle.Primary)
      );

      await channel.send({ embeds: [embed], components: [row] });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Publicar panel tipo tienda para compras: embed + imagen + select de planes
  app.post('/api/tickets/purchase-shop-panel', auth, async (req, res) => {
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

      config.purchaseTicketPlans = plans.map((p) => ({
        label: p.label,
        value: p.value,
        description: p.description,
        emoji: p.emoji,
      }));

      const menu = new StringSelectMenuBuilder()
        .setCustomId('purchase_ticket_plan')
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

  // Publicar panel de tickets en un canal (legacy)
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
