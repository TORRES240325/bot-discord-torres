async function logToChannel(client, channelId, payload) {
  try {
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;
    if (!channel.isTextBased()) return;
    await channel.send(payload);
  } catch {
  }
}

module.exports = {
  logToChannel,
};
