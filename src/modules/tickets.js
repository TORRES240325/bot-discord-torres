const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
  StringSelectMenuBuilder,
} = require('discord.js');
const { readJson, writeJsonAtomic } = require('../utils/storage');
const { logToChannel } = require('../utils/log');

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
  } catch (_) {
    return null;
  }
}

async function getTicketSettings(guildId) {
  const db = getFirestore();
  if (!db) return null;
  try {
    const doc = await db.collection('guilds').doc(String(guildId)).collection('settings').doc('tickets').get();
    if (!doc.exists) return null;
    return doc.data() || null;
  } catch (_) {
    return null;
  }
}

function applyPlaceholders(text, vars) {
  if (text == null) return '';
  return String(text)
    .replaceAll('{order}', vars.order)
    .replaceAll('{user}', vars.user)
    .replaceAll('{userId}', vars.userId)
    .replaceAll('{plan}', vars.plan);
}

function safeHexColor(input, fallback = '#5865f2') {
  const s = String(input || '').trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(s)) return s.startsWith('#') ? s : `#${s}`;
  return fallback;
}

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'tickets.json');

function slugifyShort(input, maxLen = 24) {
  if (!input) return '';
  const base = String(input)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.slice(0, maxLen);
}

function safeChannelName({ orderNumber, username, planSlug }) {
  const userSlug = slugifyShort(username, 16) || 'user';
  const orderSlug = `o${String(orderNumber).padStart(4, '0')}`;
  const parts = [orderSlug];
  if (planSlug) parts.push(slugifyShort(planSlug, 18));
  parts.push(userSlug);
  return parts.join('-').replace(/[^a-z0-9-]/g, '-').slice(0, 90);
}

function createTicketsModule(config) {
  const store = readJson(STORE_PATH, { ticketsByChannelId: {}, ticketChannelByUserId: {}, nextOrderNumber: 1 });
  if (!store.nextOrderNumber || typeof store.nextOrderNumber !== 'number') {
    store.nextOrderNumber = 1;
  }

  function persist() {
    writeJsonAtomic(STORE_PATH, store);
  }

  function openButton() {
    return new ButtonBuilder()
      .setCustomId('ticket_open')
      .setLabel('Abrir ticket')
      .setStyle(ButtonStyle.Primary);
  }

  function closeButton() {
    return new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel('Cerrar ticket')
      .setStyle(ButtonStyle.Danger);
  }

  async function postPanel(message) {
    const embed = new EmbedBuilder()
      .setTitle('Soporte')
      .setDescription('Presiona el botón para abrir un ticket.');

    const row = new ActionRowBuilder().addComponents(openButton());
    await message.channel.send({ embeds: [embed], components: [row] });
  }

  async function createTicket(interaction, client, planValue = null, ticketType = 'general') {
    if (!interaction.guild) return;

    const settings = await getTicketSettings(interaction.guild.id);
    const ticketCategoryId = settings?.ticketCategoryId || settings?.categoryId || config.ticketCategoryId;
    const ticketStaffRoleId = settings?.ticketStaffRoleId || settings?.staffRoleId || config.ticketStaffRoleId;
    const logChannelId = settings?.logChannelId || config.logChannelId;
    const channelNameTemplate = settings?.channelNameTemplate || null;

    if (!ticketCategoryId || !ticketStaffRoleId) {
      await interaction.reply({ content: 'Tickets no configurado. Revisa TICKET_CATEGORY_ID y TICKET_STAFF_ROLE_ID en .env', ephemeral: true });
      return;
    }

    const existingChannelId = store.ticketChannelByUserId[interaction.user.id];
    if (existingChannelId) {
      const ch = await interaction.guild.channels.fetch(existingChannelId).catch(() => null);
      if (ch) {
        await interaction.reply({ content: `Ya tienes un ticket abierto: <#${existingChannelId}>`, ephemeral: true });
        return;
      }
      delete store.ticketChannelByUserId[interaction.user.id];
      persist();
    }

    const orderNumber = store.nextOrderNumber;
    store.nextOrderNumber += 1;

    const plan = Array.isArray(config.ticketPlans)
      ? config.ticketPlans.find((p) => p.value === planValue)
      : null;
    const planSlug = plan?.value || plan?.label || planValue;

    const vars = {
      order: String(orderNumber),
      user: String(interaction.user.username),
      userId: String(interaction.user.id),
      plan: plan ? String(plan.label) : (planValue ? String(planValue) : ''),
    };

    const category = await interaction.guild.channels.fetch(ticketCategoryId).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory) {
      await interaction.reply({ content: 'La categoría de tickets no existe o no es válida.', ephemeral: true });
      return;
    }

    const desiredName = channelNameTemplate
      ? slugifyShort(applyPlaceholders(channelNameTemplate, vars), 90)
      : safeChannelName({ orderNumber, username: interaction.user.username, planSlug });

    const finalName = desiredName || safeChannelName({ orderNumber, username: interaction.user.username, planSlug });

    const channel = await interaction.guild.channels.create({
      name: finalName,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        {
          id: interaction.guild.roles.everyone.id,
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: interaction.user.id,
          allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
        },
        {
          id: ticketStaffRoleId,
          allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
        },
      ],
    });

    store.ticketsByChannelId[channel.id] = {
      guildId: interaction.guild.id,
      channelId: channel.id,
      userId: interaction.user.id,
      plan: planValue,
      orderNumber,
      createdAt: Date.now(),
    };
    store.ticketChannelByUserId[interaction.user.id] = channel.id;
    persist();

    const row = new ActionRowBuilder().addComponents(closeButton());

    let planText = '';
    if (planValue) {
      planText = plan ? `\n\nPlan: **${plan.label}**` : `\n\nPlan: **${planValue}**`;
    }

    await channel.send({
      content: applyPlaceholders(
        settings?.introMessage || `Orden: **#{order}**\n<@{userId}> <@&${ticketStaffRoleId}>${planText}`,
        { ...vars, order: `#${orderNumber}` }
      ),
      components: [row],
    });

    const embedCfg = settings?.welcomeEmbed || null;
    const welcomeTitle = embedCfg?.title ? applyPlaceholders(embedCfg.title, vars) : '✅ Ticket creado';
    const welcomeDesc = embedCfg?.description
      ? applyPlaceholders(embedCfg.description, vars)
      : (
          'Un administrador te responderá en breve para procesar tu compra.\n\n' +
          'Mientras esperas, envía aquí:\n' +
          '- Tu método de pago\n' +
          '- Comprobante (si aplica)\n' +
          '- Cualquier detalle adicional\n\n' +
          'No hagas spam: si tardan, es porque están atendiendo otros tickets.'
        );

    const welcome = new EmbedBuilder()
      .setColor(safeHexColor(embedCfg?.color, '#5865f2'))
      .setTitle(welcomeTitle)
      .setDescription(welcomeDesc)
      .addFields(
        { name: 'Orden', value: `#${orderNumber}`, inline: true },
        { name: 'Plan', value: plan ? plan.label : (planValue ? String(planValue) : 'No seleccionado'), inline: true }
      );

    if (Array.isArray(embedCfg?.fields) && embedCfg.fields.length > 0) {
      const extra = embedCfg.fields
        .filter((f) => f && (f.name || f.value))
        .map((f) => ({
          name: applyPlaceholders(f.name || 'Campo', vars).slice(0, 256),
          value: applyPlaceholders(f.value || '-', vars).slice(0, 1024),
          inline: Boolean(f.inline),
        }));
      if (extra.length > 0) welcome.addFields(extra);
    }

    await channel.send({ embeds: [welcome] });

    const openedLog = new EmbedBuilder()
      .setColor(0x3ba55c)
      .setTitle('Ticket Abierto')
      .addFields(
        { name: 'Nombre del Ticket', value: `${channel.name}`, inline: true },
        { name: 'Creado por', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Opened Date', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true },
        { name: 'Ticket Type', value: plan ? plan.label : (planValue ? String(planValue) : 'Support'), inline: false }
      );

    await logToChannel(client, logChannelId, { embeds: [openedLog] });

    await interaction.reply({ content: `Ticket creado: <#${channel.id}>`, ephemeral: true });

    await logToChannel(client, logChannelId, {
      content: `Ticket creado: #${orderNumber} ${interaction.user.tag} (${interaction.user.id}) -> <#${channel.id}>`,
    });
  }

  async function closeTicket(interaction, client) {
    if (!interaction.guild) return;

    const ticket = store.ticketsByChannelId[interaction.channelId];
    if (!ticket) {
      await interaction.reply({ content: 'Este canal no es un ticket (o no está registrado).', ephemeral: true });
      return;
    }

    const member = interaction.member;
    const isAdmin = member?.permissions?.has?.(PermissionsBitField.Flags.Administrator);

    if (!isAdmin) {
      await interaction.reply({ content: 'Solo un administrador puede cerrar este ticket.', ephemeral: true });
      return;
    }

    await interaction.reply({ content: 'Cerrando ticket...', ephemeral: true });

    const channel = interaction.channel;
    let transcript = '';
    if (channel && channel.isTextBased()) {
      const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      if (messages) {
        const ordered = Array.from(messages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        transcript = ordered
          .map((m) => {
            const time = new Date(m.createdTimestamp).toISOString();
            const author = `${m.author.tag}`;
            const content = (m.content ?? '').replace(/\n/g, ' ');
            return `[${time}] ${author}: ${content}`;
          })
          .join('\n');
      }
    }

    delete store.ticketsByChannelId[interaction.channelId];
    if (store.ticketChannelByUserId[ticket.userId] === interaction.channelId) {
      delete store.ticketChannelByUserId[ticket.userId];
    }
    persist();

    const closedAt = Date.now();
    const closedLog = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('Ticket Cerrado')
      .addFields(
        { name: 'Nombre del Ticket', value: `${interaction.channel?.name ?? interaction.channelId}`, inline: true },
        { name: 'Autor del Ticket', value: `<@${ticket.userId}>`, inline: true },
        { name: 'Cerrado por', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Fecha de Apertura', value: `<t:${Math.floor(ticket.createdAt / 1000)}:f>`, inline: true },
        { name: 'Fecha de Cierre', value: `<t:${Math.floor(closedAt / 1000)}:f>`, inline: true }
      );

    await logToChannel(client, config.logChannelId, { embeds: [closedLog] });

    if (transcript) {
      const max = 1800;
      const trimmed = transcript.length > max ? `${transcript.slice(0, max)}\n...` : transcript;
      await logToChannel(client, config.logChannelId, {
        content: `Transcript ticket <#${interaction.channelId}> (user ${ticket.userId})\n\n${trimmed}`,
      });
    }

    await interaction.channel.delete('Ticket cerrado').catch(() => null);
  }

  return {
    name: 'tickets',
    async onMessageCreate(message) {
      if (!message.guild) return;
      if (message.author.bot) return;

      if (message.content.trim() === '!ticketpanel') {
        if (!message.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) {
          await message.reply('Necesitas Manage Server para usar esto.').catch(() => null);
          return;
        }
        await postPanel(message);
      }
    },
    async onInteractionCreate(interaction, client) {
      if (interaction.isButton()) {
        if (interaction.customId === 'ticket_open' || interaction.customId === 'ticket_create' || interaction.customId === 'support_ticket_open') {
          const ticketType = interaction.customId === 'support_ticket_open' ? 'support' : 'general';
          await createTicket(interaction, client, null, ticketType);
        }

        if (interaction.customId === 'ticket_close') {
          await closeTicket(interaction, client);
        }
      }

      if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'ticket_plan') {
          const planValue = interaction.values?.[0] ?? null;
          await createTicket(interaction, client, planValue, 'purchase');
        }
        if (interaction.customId === 'purchase_ticket_plan') {
          const planValue = interaction.values?.[0] ?? null;
          await createTicket(interaction, client, planValue, 'purchase');
        }
      }
    },
  };
}

module.exports = {
  createTicketsModule,
};
