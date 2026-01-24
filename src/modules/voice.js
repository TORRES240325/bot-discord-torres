const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} = require('@discordjs/voice');
const { SlashCommandBuilder } = require('discord.js');
const play = require('play-dl');
const googleTTS = require('google-tts-api');

function createGuildState() {
  return {
    connection: null,
    player: createAudioPlayer(),
    queue: [],
    playing: false,
    ttsEnabled: false,
    ttsTextChannelId: null,
    ttsLock: false,
    __wired: false,
  };
}

function isUrl(s) {
  try {
    new URL(String(s));
    return true;
  } catch {
    return false;
  }
}

async function resolveQueryToTrack(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Debes escribir un link o un texto para buscar.');

  if (isUrl(q)) {
    // If it's a YouTube URL, play-dl can resolve.
    // If it's a direct media URL, play-dl may still handle it.
    return { type: 'url', title: q, url: q };
  }

  const results = await play.search(q, { limit: 1 });
  if (!results || !results.length) throw new Error('No encontré resultados para esa búsqueda.');
  const top = results[0];
  return { type: 'search', title: top.title || q, url: top.url };
}

async function createResourceFromTrack(track) {
  const url = track.url;

  if (play.yt_validate(url) === 'video' || play.yt_validate(url) === 'playlist') {
    const stream = await play.stream(url);
    return createAudioResource(stream.stream, { inputType: stream.type, inlineVolume: true, metadata: track });
  }

  // Non-youtube URL: let FFmpeg handle it
  return createAudioResource(url, { inlineVolume: true, metadata: track });
}

async function ensureConnected(guildState, interaction) {
  const member = interaction.member;
  const voice = member?.voice;
  const channel = voice?.channel;
  if (!channel) throw new Error('Debes estar en un canal de voz para usar este comando.');

  const existing = guildState.connection;
  if (existing && existing.joinConfig?.channelId === channel.id) return;

  if (existing) {
    try {
      existing.destroy();
    } catch (_) {
    }
    guildState.connection = null;
  }

  guildState.connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  guildState.connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(guildState.connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(guildState.connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      try {
        guildState.connection.destroy();
      } catch (_) {
      }
      guildState.connection = null;
    }
  });

  await entersState(guildState.connection, VoiceConnectionStatus.Ready, 15000);
  guildState.connection.subscribe(guildState.player);
}

async function playNext(guildState) {
  if (guildState.playing) return;
  const next = guildState.queue.shift();
  if (!next) return;

  guildState.playing = true;
  try {
    const res = await createResourceFromTrack(next);
    guildState.player.play(res);
  } catch (_) {
    guildState.playing = false;
    setImmediate(() => playNext(guildState));
  }
}

async function enqueueAndMaybePlay(guildState, track) {
  guildState.queue.push(track);
  if (!guildState.playing) {
    await playNext(guildState);
  }
}

async function ttsSpeak(guildState, text) {
  const msg = String(text || '').trim();
  if (!msg) return;
  if (!guildState.connection) return;
  if (guildState.ttsLock) return;

  guildState.ttsLock = true;
  try {
    const ttsUrl = googleTTS.getAudioUrl(msg.slice(0, 180), { lang: 'es', slow: false, host: 'https://translate.google.com' });
    const res = createAudioResource(ttsUrl, { inlineVolume: true });
    guildState.player.play(res);
  } finally {
    // unlock when the player becomes idle again
    const unlock = () => {
      guildState.ttsLock = false;
      guildState.player.off(AudioPlayerStatus.Idle, unlock);
    };
    guildState.player.on(AudioPlayerStatus.Idle, unlock);
  }
}

function createVoiceModule(config) {
  const guildStates = new Map();

  function stateFor(guildId) {
    const id = String(guildId);
    if (!guildStates.has(id)) guildStates.set(id, createGuildState());
    const st = guildStates.get(id);
    if (st && !st.__wired) {
      st.__wired = true;
      st.player.on(AudioPlayerStatus.Idle, () => {
        st.playing = false;
        playNext(st).catch(() => null);
      });
      st.player.on('error', () => {
        st.playing = false;
        playNext(st).catch(() => null);
      });
    }
    return st;
  }

  const commands = [
    new SlashCommandBuilder().setName('join').setDescription('Unir el bot a tu canal de voz (se queda hasta /leave)'),
    new SlashCommandBuilder().setName('leave').setDescription('Sacar el bot del canal de voz'),
    new SlashCommandBuilder()
      .setName('play')
      .setDescription('Reproducir música por link o por búsqueda')
      .addStringOption((o) => o.setName('query').setDescription('Link o búsqueda (ej: si estuviesemos juntos bad bunny)').setRequired(true)),
    new SlashCommandBuilder().setName('stop').setDescription('Detener música y vaciar la cola'),
    new SlashCommandBuilder().setName('skip').setDescription('Saltar la canción actual'),
    new SlashCommandBuilder().setName('queue').setDescription('Ver la cola de reproducción'),
    new SlashCommandBuilder()
      .setName('tts')
      .setDescription('Leer mensajes en voz en el canal actual (solo si están en el mismo voice)')
      .addStringOption((o) => o.setName('mode').setDescription('on/off').setRequired(true).addChoices(
        { name: 'on', value: 'on' },
        { name: 'off', value: 'off' },
      )),
  ];

  return {
    name: 'voice',
    getSlashCommands() {
      return commands;
    },

    async onInteractionCreate(interaction, client) {
      if (!interaction.isChatInputCommand()) return;
      const guild = interaction.guild;
      if (!guild) return;

      const st = stateFor(guild.id);

      if (interaction.commandName === 'join') {
        try {
          await ensureConnected(st, interaction);
          await interaction.reply({ content: '✅ Conectado. Me quedaré aquí hasta /leave (o si me expulsas).', ephemeral: true });
        } catch (e) {
          await interaction.reply({ content: `❌ ${String(e.message || e)}`, ephemeral: true }).catch(() => null);
        }
        return;
      }

      if (interaction.commandName === 'leave') {
        try {
          const conn = st.connection || getVoiceConnection(guild.id);
          if (conn) {
            try { conn.destroy(); } catch (_) {}
          }
          st.connection = null;
          st.queue = [];
          st.playing = false;
          st.ttsEnabled = false;
          st.ttsTextChannelId = null;
          await interaction.reply({ content: '👋 Listo, salí del canal.', ephemeral: true });
        } catch (e) {
          await interaction.reply({ content: `❌ ${String(e.message || e)}`, ephemeral: true }).catch(() => null);
        }
        return;
      }

      if (interaction.commandName === 'play') {
        try {
          await ensureConnected(st, interaction);
          const query = interaction.options.getString('query', true);
          const track = await resolveQueryToTrack(query);
          await enqueueAndMaybePlay(st, track);
          await interaction.reply({ content: `🎵 En cola: **${track.title}**`, ephemeral: true });
        } catch (e) {
          await interaction.reply({ content: `❌ ${String(e.message || e)}`, ephemeral: true }).catch(() => null);
        }
        return;
      }

      if (interaction.commandName === 'stop') {
        try {
          st.queue = [];
          st.playing = false;
          st.player.stop(true);
          await interaction.reply({ content: '⏹️ Detenido y cola vacía.', ephemeral: true });
        } catch (e) {
          await interaction.reply({ content: `❌ ${String(e.message || e)}`, ephemeral: true }).catch(() => null);
        }
        return;
      }

      if (interaction.commandName === 'skip') {
        try {
          st.playing = false;
          st.player.stop(true);
          await interaction.reply({ content: '⏭️ Saltado.', ephemeral: true });
        } catch (e) {
          await interaction.reply({ content: `❌ ${String(e.message || e)}`, ephemeral: true }).catch(() => null);
        }
        return;
      }

      if (interaction.commandName === 'queue') {
        try {
          if (!st.queue.length) {
            await interaction.reply({ content: '📭 Cola vacía.', ephemeral: true });
            return;
          }
          const lines = st.queue.slice(0, 10).map((t, i) => `${i + 1}. ${t.title || t.url}`);
          const extra = st.queue.length > 10 ? `\n(+${st.queue.length - 10} más)` : '';
          await interaction.reply({ content: `📜 Cola:\n${lines.join('\n')}${extra}`, ephemeral: true });
        } catch (e) {
          await interaction.reply({ content: `❌ ${String(e.message || e)}`, ephemeral: true }).catch(() => null);
        }
        return;
      }

      if (interaction.commandName === 'tts') {
        try {
          await ensureConnected(st, interaction);
          const mode = interaction.options.getString('mode', true);
          if (mode === 'on') {
            st.ttsEnabled = true;
            st.ttsTextChannelId = interaction.channelId;
            await interaction.reply({ content: '🔊 TTS activado en este canal. Leeré mensajes de usuarios que estén en el mismo canal de voz.', ephemeral: true });
          } else {
            st.ttsEnabled = false;
            st.ttsTextChannelId = null;
            await interaction.reply({ content: '🔇 TTS desactivado.', ephemeral: true });
          }
        } catch (e) {
          await interaction.reply({ content: `❌ ${String(e.message || e)}`, ephemeral: true }).catch(() => null);
        }
      }
    },

    async onMessageCreate(message, client) {
      if (!message.guild) return;
      if (message.author.bot) return;

      const st = guildStates.get(String(message.guild.id));
      if (!st || !st.ttsEnabled) return;
      if (!st.connection) return;
      if (!st.ttsTextChannelId || String(message.channelId) !== String(st.ttsTextChannelId)) return;

      const botVoiceChannelId = st.connection.joinConfig?.channelId;
      const member = message.member;
      const memberVoiceChannelId = member?.voice?.channelId;

      if (!botVoiceChannelId) return;
      if (!memberVoiceChannelId) return;
      if (String(memberVoiceChannelId) !== String(botVoiceChannelId)) return;

      const content = String(message.content || '').trim();
      if (!content) return;

      const speak = `${message.member?.displayName || message.author.username}: ${content}`;
      await ttsSpeak(st, speak).catch(() => null);
    },
  };
}

module.exports = {
  createVoiceModule,
};
