const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} = require('@discordjs/voice');
const { SlashCommandBuilder } = require('discord.js');
const play = require('play-dl');
const googleTTS = require('google-tts-api');

try {
  const ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath && !process.env.FFMPEG_PATH) process.env.FFMPEG_PATH = ffmpegPath;
} catch (_) {
}

function createGuildState() {
  return {
    connection: null,
    player: createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
      },
    }),
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

function normalizeTrackUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (raw === 'undefined' || raw === 'null') return null;

  // common cases without protocol
  if (raw.startsWith('www.')) return `https://${raw}`;
  if (raw.startsWith('youtube.com') || raw.startsWith('youtu.be/')) return `https://${raw}`;
  if (raw.startsWith('music.youtube.com')) return `https://${raw}`;

  // youtube video id
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return `https://www.youtube.com/watch?v=${raw}`;

  // already a URL
  if (isUrl(raw)) return raw;

  return null;
}

function shortErrorMessage(err) {
  try {
    const raw = String(err?.message || err || '').trim();
    if (!raw) return 'Ocurrió un error inesperado.';
    if (/browseId/i.test(raw)) return 'No pude buscar esa canción. Prueba con un link o escribe el nombre más específico.';
    if (/NoSuchKey/i.test(raw)) return 'No pude acceder al audio. Prueba con otro link.';
    return raw;
  } catch {
    return 'Ocurrió un error inesperado.';
  }
}

async function safeReply(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: String(content) });
    } else {
      await interaction.reply({ content: String(content) });
    }
  } catch (_) {
  }
}

async function resolveQueryToTrack(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Debes escribir un link o un texto para buscar.');

  if (isUrl(q)) {
    const v = play.yt_validate(q);
    if (v === 'playlist') {
      const pl = await play.playlist_info(q, { incomplete: true }).catch(() => null);
      if (pl) {
        const vids = await pl.all_videos().catch(() => []);
        const first = vids && vids.length ? vids[0] : null;
        const url = normalizeTrackUrl(first?.url || first?.id);
        if (url) return { type: 'playlist', title: first.title || 'Primer video de la playlist', url };
      }
      throw new Error('Esa playlist no se pudo leer. Prueba con un link directo a una canción/video.');
    }
    const url = normalizeTrackUrl(q);
    if (!url) throw new Error('Ese link no parece válido. Pega un link completo (https://...) o prueba otra canción.');
    return { type: 'url', title: q, url };
  }

  let results = [];
  try {
    results = await play.search(q, { limit: 1, source: { youtube: 'video' } });
  } catch (_) {
    results = [];
  }
  if (!results || !results.length) throw new Error('No encontré resultados para esa búsqueda.');
  const top = results[0];
  const url = normalizeTrackUrl(top?.url || top?.id);
  if (!url) throw new Error('No pude obtener el link del resultado. Prueba con otro nombre o un link directo.');
  return { type: 'search', title: top.title || q, url };
}

async function createResourceFromTrack(track) {
  const url = normalizeTrackUrl(track?.url);
  if (!url) {
    throw new Error('No pude obtener un enlace válido para reproducir esta canción. Intenta de nuevo con otro nombre o pega el link directo.');
  }

  if (play.yt_validate(url) === 'video' || play.yt_validate(url) === 'playlist') {
    const stream = await play.stream(url);
    const res = createAudioResource(stream.stream, { inputType: stream.type, inlineVolume: true, metadata: track });
    try {
      if (res?.volume) res.volume.setVolume(0.8);
    } catch (_) {
    }
    return res;
  }

  // Non-youtube URL: let FFmpeg handle it
  const res = createAudioResource(url, { inlineVolume: true, metadata: track });
  try {
    if (res?.volume) res.volume.setVolume(0.8);
  } catch (_) {
  }
  return res;
}

async function ensureConnected(guildState, interaction) {
  const member = interaction.member;
  const voice = member?.voice;
  const channel = voice?.channel;
  if (!channel) throw new Error('Debes estar en un canal de voz para usar este comando.');

  const existing = guildState.connection;
  if (existing && existing.joinConfig?.channelId === channel.id) {
    try {
      existing.subscribe(guildState.player);
    } catch (_) {
    }
    return;
  }

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
    selfDeaf: true,
  });

  guildState.connection.on('stateChange', (oldState, newState) => {
    try {
      if (oldState.status !== newState.status) {
        console.log(`[voice] conn ${channel.guild.id} ${oldState.status} -> ${newState.status}`);
      }
    } catch (_) {
    }
    if (newState.status === VoiceConnectionStatus.Ready) {
      try {
        guildState.connection.subscribe(guildState.player);
      } catch (_) {
      }
    }
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

  try {
    await entersState(guildState.connection, VoiceConnectionStatus.Ready, 15000);
  } catch (e) {
    throw new Error('No pude establecer la conexión de voz. Revisa permisos (Conectar/Hablar) y que el bot tenga soporte de cifrado (libsodium).');
  }
  try {
    guildState.connection.subscribe(guildState.player);
  } catch (_) {
  }
}

async function playNext(guildState) {
  if (guildState.playing) return;
  const next = guildState.queue.shift();
  if (!next) return;

  guildState.playing = true;
  try {
    const res = await createResourceFromTrack(next);
    guildState.player.play(res);
  } catch (e) {
    try {
      console.error('[voice] playNext failed:', e);
    } catch (_) {
    }
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
      st.player.on('stateChange', (oldState, newState) => {
        try {
          console.log(`[voice] player ${id} ${oldState.status} -> ${newState.status}`);
        } catch (_) {
        }
      });
      st.player.on(AudioPlayerStatus.Playing, () => {
        try {
          const md = st.player?.state?.resource?.metadata;
          console.log(`[voice] now playing ${id}: ${md?.title || md?.url || 'unknown'}`);
        } catch (_) {
        }
      });
      st.player.on(AudioPlayerStatus.Idle, () => {
        st.playing = false;
        playNext(st).catch(() => null);
      });
      st.player.on('error', (err) => {
        try {
          console.error(`[voice] player error ${id}:`, err);
        } catch (_) {
        }
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

    async onReady() {
      try {
        const sodium = require('libsodium-wrappers');
        if (sodium?.ready) await sodium.ready;
      } catch (_) {
      }
    },

    async onInteractionCreate(interaction, client) {
      if (!interaction.isChatInputCommand()) return;
      const guild = interaction.guild;
      if (!guild) return;

      const st = stateFor(guild.id);

      if (interaction.commandName === 'join') {
        try {
          await ensureConnected(st, interaction);
          await safeReply(interaction, '✅ Conectado. Me quedaré aquí hasta que uses /leave (o si me expulsas).');
        } catch (e) {
          console.error('voice /join error:', e);
          await safeReply(interaction, `❌ ${shortErrorMessage(e)}`);
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
          await safeReply(interaction, '👋 Listo, salí del canal de voz.');
        } catch (e) {
          console.error('voice /leave error:', e);
          await safeReply(interaction, `❌ ${shortErrorMessage(e)}`);
        }
        return;
      }

      if (interaction.commandName === 'play') {
        try {
          await ensureConnected(st, interaction);
          const query = interaction.options.getString('query', true);
          const track = await resolveQueryToTrack(query);
          const willStartNow = !st.playing && st.queue.length === 0;
          await enqueueAndMaybePlay(st, track);
          await safeReply(interaction, willStartNow
            ? `▶️ Reproduciendo: **${track.title}**`
            : `🎵 En cola: **${track.title}**`
          );
        } catch (e) {
          console.error('voice /play error:', e);
          await safeReply(interaction, `❌ ${shortErrorMessage(e)}`);
        }
        return;
      }

      if (interaction.commandName === 'stop') {
        try {
          st.queue = [];
          st.playing = false;
          st.player.stop(true);
          await safeReply(interaction, '⏹️ Detenido. Cola vacía.');
        } catch (e) {
          console.error('voice /stop error:', e);
          await safeReply(interaction, `❌ ${shortErrorMessage(e)}`);
        }
        return;
      }

      if (interaction.commandName === 'skip') {
        try {
          st.playing = false;
          st.player.stop(true);
          await safeReply(interaction, '⏭️ Saltado.');
        } catch (e) {
          console.error('voice /skip error:', e);
          await safeReply(interaction, `❌ ${shortErrorMessage(e)}`);
        }
        return;
      }

      if (interaction.commandName === 'queue') {
        try {
          if (!st.queue.length) {
            await safeReply(interaction, '📭 Cola vacía.');
            return;
          }
          const lines = st.queue.slice(0, 10).map((t, i) => `${i + 1}. ${t.title || t.url}`);
          const extra = st.queue.length > 10 ? `\n(+${st.queue.length - 10} más)` : '';
          await safeReply(interaction, `📜 Cola:\n${lines.join('\n')}${extra}`);
        } catch (e) {
          console.error('voice /queue error:', e);
          await safeReply(interaction, `❌ ${shortErrorMessage(e)}`);
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
            await safeReply(interaction, '🔊 TTS activado en este canal. Leeré mensajes solo de usuarios que estén en el mismo canal de voz que yo.');
          } else {
            st.ttsEnabled = false;
            st.ttsTextChannelId = null;
            await safeReply(interaction, '🔇 TTS desactivado.');
          }
        } catch (e) {
          console.error('voice /tts error:', e);
          await safeReply(interaction, `❌ ${shortErrorMessage(e)}`);
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
