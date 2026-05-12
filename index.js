import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';

const {
  AUTO_DEPLOY_COMMANDS,
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_D1_DATABASE_ID,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  DISCORD_TOKEN,
  D1_IMPORT_JSON_ON_START,
  LOG_CHANNEL_ID,
  STORAGE_DRIVER
} = process.env;

if (!DISCORD_TOKEN) {
  throw new Error('Missing DISCORD_TOKEN in environment variables');
}

const ethAddressPattern = /^0x[a-fA-F0-9]{40}$/;
const dataDir = path.resolve('data');
const listsPath = path.join(dataDir, 'lists.json');
const walletsPath = path.join(dataDir, 'wallets.json');
const storageDriver =
  STORAGE_DRIVER === 'd1' ||
  (CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_D1_DATABASE_ID && CLOUDFLARE_API_TOKEN)
    ? 'd1'
    : 'json';
let cachedLists = null;
let cachedWallets = null;

const walletListCommand = new SlashCommandBuilder()
  .setName('wallet-list')
  .setDescription('Manage role-gated ETH wallet lists.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((subcommand) => addRuleOptions(
    subcommand
      .setName('create')
      .setDescription('Create a wallet list and post its submission button.')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('List name, for example Presale or Allowlist A.')
          .setRequired(true)
          .setMaxLength(60)
      )
  ).addChannelOption((option) =>
    option
      .setName('channel')
      .setDescription('Where to post the wallet submission panel.')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false)
  ))
  .addSubcommand((subcommand) => addRuleOptions(
    subcommand
      .setName('rules')
      .setDescription('Replace the role rules for an existing wallet list.')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Existing wallet list name.')
          .setRequired(true)
          .setMaxLength(60)
      )
  ))
  .addSubcommand((subcommand) =>
    subcommand
      .setName('export')
      .setDescription('Download a wallet list as CSV or JSON.')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Existing wallet list name.')
          .setRequired(true)
          .setMaxLength(60)
      )
      .addStringOption((option) =>
        option
          .setName('format')
          .setDescription('Download format.')
          .addChoices({ name: 'CSV', value: 'csv' }, { name: 'JSON', value: 'json' })
          .setRequired(false)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('show')
      .setDescription('Show configured wallet lists and role rules.')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Optional list name or ID to inspect.')
          .setRequired(false)
          .setMaxLength(60)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('panel')
      .setDescription('Post a fresh submission button for an existing wallet list.')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Existing wallet list name or ID.')
          .setRequired(true)
          .setMaxLength(60)
      )
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Where to post the fresh wallet submission panel.')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('delete')
      .setDescription('Delete a wallet list and its saved wallet submissions.')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Existing wallet list name or ID.')
          .setRequired(true)
          .setMaxLength(60)
      )
  );

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

if (process.argv.includes('--deploy-only')) {
  await registerSlashCommands();
  process.exit(0);
}

if (AUTO_DEPLOY_COMMANDS === 'true') {
  await registerSlashCommands();
}

await loadStores();

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'wallet-list') {
      await handleWalletListCommand(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('wallet_submit:')) {
      await handleWalletButton(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('wallet_modal:')) {
      await handleWalletModal(interaction);
    }
  } catch (error) {
    console.error(error);

    await respondSafely(interaction, {
      content: 'Something went wrong while handling that interaction.',
      ephemeral: true
    });
  }
});

async function handleWalletListCommand(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'create') {
    await handleCreateList(interaction);
    return;
  }

  if (subcommand === 'rules') {
    await handleUpdateRules(interaction);
    return;
  }

  if (subcommand === 'export') {
    await handleExportList(interaction);
    return;
  }

  if (subcommand === 'show') {
    await handleShowLists(interaction);
    return;
  }

  if (subcommand === 'panel') {
    await handlePostPanel(interaction);
    return;
  }

  if (subcommand === 'delete') {
    await handleDeleteList(interaction);
  }
}

async function handleCreateList(interaction) {
  if (!(await deferSafely(interaction))) {
    return;
  }

  const name = interaction.options.getString('name', true).trim();
  const [, existingList] = await findListByName(interaction.guildId, name);

  if (existingList) {
    await editReplySafely(
      interaction,
      `A wallet list named **${name}** already exists. Use \`/wallet-list rules\` to change its role rules.`
    );
    return;
  }

  const rules = collectRoleRules(interaction);
  const targetChannel = interaction.options.getChannel('channel') ?? interaction.channel;
  const listId = randomUUID().slice(0, 12);
  const now = new Date().toISOString();
  const list = {
    id: listId,
    name,
    guildId: interaction.guildId,
    channelId: targetChannel.id,
    rules,
    createdBy: interaction.user.id,
    createdAt: now,
    updatedAt: now
  };

  await saveList(listId, list);

  try {
    await sendWalletPanel(targetChannel, list);
  } catch (error) {
    await deleteList(listId);

    if (error.code === 50001 || error.code === 50013) {
      await editReplySafely(
        interaction,
        `I cannot post in ${targetChannel}. Please give the bot permission to View Channel and Send Messages there, then run \`/wallet-list create\` again.`
      );
      return;
    }

    throw error;
  }

  await editReplySafely(
    interaction,
    `Created **${name}** in ${targetChannel}.\nID: \`${listId}\`\n${formatRules(rules)}`
  );
}

async function handleUpdateRules(interaction) {
  if (!(await deferSafely(interaction))) {
    return;
  }

  const name = interaction.options.getString('name', true).trim();
  const [listId, list] = await findListByName(interaction.guildId, name);

  if (!list) {
    await editReplySafely(interaction, `I could not find a wallet list named **${name}**.`);
    return;
  }

  const rules = collectRoleRules(interaction);
  await saveList(listId, {
    ...list,
    rules,
    updatedAt: new Date().toISOString()
  });

  await editReplySafely(interaction, `Updated rules for **${list.name}**.\n${formatRules(rules)}`);
}

async function handleExportList(interaction) {
  if (!(await deferSafely(interaction))) {
    return;
  }

  const name = interaction.options.getString('name', true).trim();
  const format = interaction.options.getString('format') ?? 'csv';
  const [, list] = await findListByName(interaction.guildId, name);

  if (!list) {
    await editReplySafely(interaction, `I could not find a wallet list named **${name}**.`);
    return;
  }

  const rows = flattenWalletEntries(await getWalletEntries(list.id));
  const safeName = list.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const attachment =
    format === 'json'
      ? buildJsonAttachment(rows, `${safeName || 'wallet-list'}.json`)
      : buildCsvAttachment(rows, `${safeName || 'wallet-list'}.csv`);

  await editReplySafely(interaction, {
    content: `Exported **${list.name}** with ${rows.length} wallet${rows.length === 1 ? '' : 's'}.`,
    files: [attachment]
  });
}

async function handleShowLists(interaction) {
  if (!(await deferSafely(interaction))) {
    return;
  }

  const name = interaction.options.getString('name')?.trim();

  if (name) {
    const [, list] = await findList(interaction.guildId, name);

    if (!list) {
      await editReplySafely(interaction, `I could not find a wallet list named **${name}**.`);
      return;
    }

    const count = flattenWalletEntries(await getWalletEntries(list.id)).length;

    await editReplySafely(interaction, {
      embeds: [
        new EmbedBuilder()
          .setTitle(list.name)
          .setDescription(`${count} submitted wallet${count === 1 ? '' : 's'}.\n\n${formatRules(list.rules)}`)
          .setColor(0x2f80ed)
      ]
    });
    return;
  }

  const lists = await getGuildLists(interaction.guildId);

  if (lists.length === 0) {
    await editReplySafely(interaction, 'No wallet lists exist yet. Create one with `/wallet-list create`.');
    return;
  }

  await editReplySafely(interaction, {
    embeds: [
      new EmbedBuilder()
        .setTitle('Wallet lists')
        .setDescription((await Promise.all(lists.map(formatListSummary))).join('\n\n'))
        .setColor(0x2f80ed)
    ]
  });
}

async function handleDeleteList(interaction) {
  if (!(await deferSafely(interaction))) {
    return;
  }

  const name = interaction.options.getString('name', true).trim();
  const [listId, list] = await findList(interaction.guildId, name);

  if (!list) {
    await editReplySafely(interaction, `I could not find a wallet list named or identified by **${name}**.`);
    return;
  }

  await deleteList(listId);
  await deleteWalletEntries(listId);

  await editReplySafely(
    interaction,
    `Deleted **${list.name}** and its saved wallet submissions. Existing old buttons for this list will no longer work.`
  );
}

async function handlePostPanel(interaction) {
  if (!(await deferSafely(interaction))) {
    return;
  }

  const name = interaction.options.getString('name', true).trim();
  const [listId, list] = await findList(interaction.guildId, name);

  if (!list) {
    await editReplySafely(interaction, `I could not find a wallet list named or identified by **${name}**.`);
    return;
  }

  const targetChannel = interaction.options.getChannel('channel') ?? interaction.channel;
  const updatedList = {
    ...list,
    id: listId,
    channelId: targetChannel.id,
    updatedAt: new Date().toISOString()
  };

  try {
    await sendWalletPanel(targetChannel, updatedList);
  } catch (error) {
    if (error.code === 50001 || error.code === 50013) {
      await editReplySafely(
        interaction,
        `I cannot post in ${targetChannel}. Please give the bot permission to View Channel and Send Messages there, then run \`/wallet-list panel\` again.`
      );
      return;
    }

    throw error;
  }

  await saveList(listId, updatedList);

  await editReplySafely(
    interaction,
    `Posted a fresh button for **${updatedList.name}** in ${targetChannel}. You can delete older button messages if they show "no longer configured."`
  );
}

async function sendWalletPanel(channel, list) {
  const embed = new EmbedBuilder()
    .setTitle(`${list.name} wallet submission`)
    .setDescription('Click the button below to submit an ETH wallet address.')
    .addFields({ name: 'Allowed roles', value: formatRules(list.rules) })
    .setColor(0x2f80ed);

  const button = new ButtonBuilder()
    .setCustomId(`wallet_submit:${list.id}`)
    .setLabel('Submit ETH wallet')
    .setStyle(ButtonStyle.Primary);

  await channel.send({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(button)]
  });
}

async function handleWalletButton(interaction) {
  const listId = interaction.customId.split(':')[1];
  await recoverListFromButtonMessage(interaction, listId);

  const walletInput = new TextInputBuilder()
    .setCustomId('wallet_address')
    .setLabel('ETH wallet address')
    .setPlaceholder('0x0000000000000000000000000000000000000000')
    .setStyle(TextInputStyle.Short)
    .setMinLength(42)
    .setMaxLength(42)
    .setRequired(true);

  const modal = new ModalBuilder()
    .setCustomId(`wallet_modal:${listId}`)
    .setTitle('Submit ETH wallet')
    .addComponents(new ActionRowBuilder().addComponents(walletInput));

  try {
    await interaction.showModal(modal);
  } catch (error) {
    if (error.code === 10062) {
      console.warn('Could not open wallet modal before the button interaction expired.');
      return;
    }

    if (error.code === 40060) {
      console.warn('Wallet button interaction was already acknowledged.');
      return;
    }

    throw error;
  }
}

async function handleWalletModal(interaction) {
  const listId = interaction.customId.split(':')[1];

  if (!(await deferSafely(interaction))) {
    return;
  }

  const list = await getList(listId);

  if (!list) {
    const guildLists = await getGuildLists(interaction.guildId);
    const knownLists = guildLists.length
      ? guildLists.map(([id, guildList]) => `${guildList.name} (${id})`).join(', ')
      : 'none';

    console.warn(
      `Missing wallet list ${listId} for guild ${interaction.guildId} after modal submit. Known lists: ${knownLists}`
    );

    await editReplySafely(interaction, {
      content: `This wallet list is no longer configured.\nMissing list ID: \`${listId}\`\nKnown lists in this server: ${knownLists}`,
      ephemeral: true
    });
    return;
  }

  if (list.guildId !== interaction.guildId) {
    await editReplySafely(interaction, {
      content: `This wallet list belongs to another server record.\nSaved server ID: \`${list.guildId}\`\nClicked server ID: \`${interaction.guildId}\``,
      ephemeral: true
    });
    return;
  }

  const maxWallets = getMaxWalletsForMember(interaction.member, list.rules);

  if (!maxWallets) {
    await editReplySafely(interaction, {
      content: 'You do not have one of the required roles for this wallet list.',
      ephemeral: true
    });
    return;
  }

  const address = interaction.fields.getTextInputValue('wallet_address').trim();

  if (!ethAddressPattern.test(address)) {
    await editReplySafely(interaction, {
      content: 'That does not look like a valid ETH address. It must start with `0x` and contain 40 hex characters.',
      ephemeral: true
    });
    return;
  }

  const submittedAt = new Date().toISOString();
  const result = await addWalletSubmission(
    list.id,
    interaction.user.id,
    {
      address,
      username: interaction.user.tag,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      submittedAt
    },
    maxWallets
  );

  if (!result.saved && result.reason === 'duplicate') {
    await editReplySafely(interaction, {
      content: `That wallet is already saved for **${list.name}**.`,
      ephemeral: true
    });
    return;
  }

  if (!result.saved && result.reason === 'limit') {
    await editReplySafely(interaction, {
      content: `You already submitted the maximum of ${maxWallets} wallet${maxWallets === 1 ? '' : 's'} for **${list.name}**.`,
      ephemeral: true
    });
    return;
  }

  await logWalletSubmission(interaction, list, address, submittedAt, result.count, maxWallets);

  await editReplySafely(interaction, {
    content: `Wallet saved for **${list.name}**. You have submitted ${result.count}/${maxWallets}.`,
    ephemeral: true
  });
}

function addRuleOptions(subcommand) {
  subcommand
    .addRoleOption((option) =>
      option
        .setName('role_1')
        .setDescription('A role allowed to submit wallets.')
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName('max_1')
        .setDescription('How many wallets members with role_1 may submit.')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true)
    );

  for (let index = 2; index <= 5; index += 1) {
    subcommand
      .addRoleOption((option) =>
        option
          .setName(`role_${index}`)
          .setDescription('Another allowed role.')
          .setRequired(false)
      )
      .addIntegerOption((option) =>
        option
          .setName(`max_${index}`)
          .setDescription(`Wallet limit for role_${index}. Defaults to max_1 if omitted.`)
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(false)
      );
  }

  return subcommand;
}

function collectRoleRules(interaction) {
  const rules = [];
  const defaultMax = interaction.options.getInteger('max_1', true);

  for (let index = 1; index <= 5; index += 1) {
    const role = interaction.options.getRole(`role_${index}`);

    if (!role || rules.some((rule) => rule.roleId === role.id)) {
      continue;
    }

    rules.push({
      roleId: role.id,
      maxWallets: interaction.options.getInteger(`max_${index}`) ?? defaultMax
    });
  }

  return rules;
}

function getMaxWalletsForMember(member, rules) {
  const matchingLimits = rules
    .filter((rule) => memberHasRole(member, rule.roleId))
    .map((rule) => rule.maxWallets);

  return matchingLimits.length > 0 ? Math.max(...matchingLimits) : null;
}

function memberHasRole(member, roleId) {
  if (member.roles?.cache) {
    return member.roles.cache.has(roleId);
  }

  if (Array.isArray(member.roles)) {
    return member.roles.includes(roleId);
  }

  return false;
}

async function getUserWalletCount(listId, userId) {
  const entries = await getWalletEntries(listId);
  return entries[userId]?.length ?? 0;
}

async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true });
}

async function loadStores() {
  if (storageDriver === 'd1') {
    await ensureD1Schema();
    if (D1_IMPORT_JSON_ON_START === 'true') {
      await importLocalJsonToD1();
    }
    const lists = await getGuildLists(DISCORD_GUILD_ID);
    console.log(`Storage: Cloudflare D1. Loaded ${lists.length} wallet list(s) for this guild.`);
    return;
  }

  await ensureDataDir();
  cachedLists = await readJson(listsPath, {});
  cachedWallets = await readJson(walletsPath, {});
  console.log(
    `Storage: local JSON. Data directory: ${dataDir}. Loaded ${Object.keys(cachedLists).length} wallet list(s).`
  );
}

async function readJson(filePath, fallback) {
  try {
    const contents = await readFile(filePath, 'utf8');
    return JSON.parse(contents);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await ensureDataDir();
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function getListsStore() {
  if (storageDriver === 'd1') {
    cachedLists = await getAllD1Lists();
    return cachedLists;
  }

  cachedLists ??= await readJson(listsPath, {});
  return cachedLists;
}

async function writeListsStore(lists) {
  if (storageDriver === 'd1') {
    cachedLists = lists;
    await Promise.all(Object.entries(lists).map(([listId, list]) => upsertD1List(listId, list)));
    return;
  }

  cachedLists = lists;
  await writeJson(listsPath, lists);
}

async function getWalletsStore() {
  if (storageDriver === 'd1') {
    return {};
  }

  cachedWallets ??= await readJson(walletsPath, {});
  return cachedWallets;
}

async function writeWalletsStore(wallets) {
  if (storageDriver === 'd1') {
    cachedWallets = wallets;
    return;
  }

  cachedWallets = wallets;
  await writeJson(walletsPath, wallets);
}

async function recoverListFromButtonMessage(interaction, listId) {
  if (cachedLists?.[listId]) {
    return cachedLists[listId];
  }

  const embed = interaction.message?.embeds?.[0];
  const name = embed?.title?.replace(/\s+wallet submission$/i, '').trim();
  const allowedRoles = embed?.fields?.find((field) => field.name === 'Allowed roles')?.value;

  if (!name || !allowedRoles) {
    return null;
  }

  const rules = [];
  const rolePattern = /<@&(\d+)>:\s*(\d+)\s*wallet/gi;
  let match = rolePattern.exec(allowedRoles);

  while (match) {
    rules.push({
      roleId: match[1],
      maxWallets: Number(match[2])
    });
    match = rolePattern.exec(allowedRoles);
  }

  if (rules.length === 0) {
    return null;
  }

  const now = new Date().toISOString();
  const recoveredList = {
    id: listId,
    name,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    rules,
    createdBy: 'recovered-from-message',
    createdAt: now,
    updatedAt: now
  };

  cachedLists ??= {};
  cachedLists[listId] = recoveredList;

  try {
    await writeListsStore(cachedLists);
  } catch (error) {
    console.error(`Failed to persist recovered wallet list ${listId}`, error);
  }

  console.log(`Recovered wallet list ${name} (${listId}) from button message.`);

  return recoveredList;
}

async function saveList(listId, list) {
  if (storageDriver === 'd1') {
    await upsertD1List(listId, list);
    cachedLists ??= {};
    cachedLists[listId] = list;
    console.log(`Saved wallet list ${list.name} (${listId}) for guild ${list.guildId}`);
    return;
  }

  const lists = await getListsStore();
  lists[listId] = list;
  await writeListsStore(lists);
  console.log(`Saved wallet list ${list.name} (${listId}) for guild ${list.guildId}`);
}

async function deleteList(listId) {
  if (storageDriver === 'd1') {
    await d1Query('DELETE FROM wallet_lists WHERE id = ?', [listId]);
    delete cachedLists?.[listId];
    return;
  }

  const lists = await getListsStore();
  delete lists[listId];
  await writeListsStore(lists);
}

async function getList(listId) {
  if (storageDriver === 'd1') {
    return getD1List(listId);
  }

  const lists = await getListsStore();
  return lists[listId] ?? null;
}

async function findListByName(guildId, name) {
  if (storageDriver === 'd1') {
    return findD1ListByName(guildId, name);
  }

  const lists = await getListsStore();
  const normalizedName = normalizeName(name);

  return (
    Object.entries(lists).find(
      ([, list]) => list.guildId === guildId && normalizeName(list.name) === normalizedName
    ) ?? [null, null]
  );
}

async function findList(guildId, nameOrId) {
  if (storageDriver === 'd1') {
    return findD1List(guildId, nameOrId);
  }

  const lists = await getListsStore();
  const normalizedInput = normalizeName(nameOrId);

  return (
    Object.entries(lists).find(
      ([listId, list]) =>
        list.guildId === guildId &&
        (listId === nameOrId || list.id === nameOrId || normalizeName(list.name) === normalizedInput)
    ) ?? [null, null]
  );
}

async function getGuildLists(guildId) {
  if (storageDriver === 'd1') {
    return getD1GuildLists(guildId);
  }

  const lists = await getListsStore();
  return Object.entries(lists).filter(([, list]) => list.guildId === guildId);
}

async function addWalletSubmission(listId, userId, submission, maxWallets) {
  if (storageDriver === 'd1') {
    return addD1WalletSubmission(listId, userId, submission, maxWallets);
  }

  const wallets = await getWalletsStore();
  wallets[listId] ??= {};
  wallets[listId][userId] ??= [];

  const userWallets = wallets[listId][userId];

  if (userWallets.some((wallet) => wallet.address.toLowerCase() === submission.address.toLowerCase())) {
    return { saved: false, reason: 'duplicate', count: userWallets.length };
  }

  if (userWallets.length >= maxWallets) {
    return { saved: false, reason: 'limit', count: userWallets.length };
  }

  userWallets.push(submission);
  await writeWalletsStore(wallets);

  return { saved: true, count: userWallets.length };
}

async function getWalletEntries(listId) {
  if (storageDriver === 'd1') {
    return getD1WalletEntries(listId);
  }

  const wallets = await getWalletsStore();
  return wallets[listId] ?? {};
}

async function deleteWalletEntries(listId) {
  if (storageDriver === 'd1') {
    await d1Query('DELETE FROM wallet_submissions WHERE list_id = ?', [listId]);
    return;
  }

  const wallets = await getWalletsStore();
  delete wallets[listId];
  await writeWalletsStore(wallets);
}

async function ensureD1Schema() {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_D1_DATABASE_ID || !CLOUDFLARE_API_TOKEN) {
    throw new Error(
      'D1 storage requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, and CLOUDFLARE_API_TOKEN.'
    );
  }

  await d1Query(`
    CREATE TABLE IF NOT EXISTS wallet_lists (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      rules_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (guild_id, normalized_name)
    )
  `);

  await d1Query(`
    CREATE TABLE IF NOT EXISTS wallet_submissions (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      address TEXT NOT NULL,
      address_lower TEXT NOT NULL,
      username TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      UNIQUE (list_id, user_id, address_lower),
      FOREIGN KEY (list_id) REFERENCES wallet_lists(id) ON DELETE CASCADE
    )
  `);

  await d1Query('CREATE INDEX IF NOT EXISTS idx_wallet_lists_guild ON wallet_lists (guild_id)');
  await d1Query(
    'CREATE INDEX IF NOT EXISTS idx_wallet_submissions_list_user ON wallet_submissions (list_id, user_id)'
  );
}

async function importLocalJsonToD1() {
  const lists = await readJson(listsPath, {});
  const wallets = await readJson(walletsPath, {});

  for (const [listId, list] of Object.entries(lists)) {
    await upsertD1List(listId, list);
  }

  for (const [listId, entriesByUser] of Object.entries(wallets)) {
    for (const [userId, submissions] of Object.entries(entriesByUser)) {
      for (const submission of submissions) {
        await d1Query(
          `
            INSERT OR IGNORE INTO wallet_submissions (
              id, list_id, user_id, address, address_lower, username, guild_id, submitted_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            randomUUID(),
            listId,
            userId,
            submission.address,
            submission.address.toLowerCase(),
            submission.username,
            submission.guildId,
            submission.submittedAt
          ]
        );
      }
    }
  }

  const walletCount = Object.values(wallets).reduce(
    (total, entriesByUser) =>
      total + Object.values(entriesByUser).reduce((userTotal, submissions) => userTotal + submissions.length, 0),
    0
  );

  console.log(`Imported local JSON into D1: ${Object.keys(lists).length} list(s), ${walletCount} wallet(s).`);
}

async function d1Query(sql, params = []) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${CLOUDFLARE_D1_DATABASE_ID}/query`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sql, params })
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || payload?.success === false) {
    const message = payload?.errors?.map((error) => error.message).join('; ') || response.statusText;
    throw new Error(`Cloudflare D1 query failed: ${message}`);
  }

  const result = Array.isArray(payload?.result) ? payload.result[0] : payload?.result;

  if (result?.success === false) {
    throw new Error(`Cloudflare D1 query failed: ${result.error || 'unknown error'}`);
  }

  return result ?? payload;
}

function d1Rows(result) {
  return result?.results ?? [];
}

function d1Changes(result) {
  return Number(result?.meta?.changes ?? 0);
}

async function getAllD1Lists() {
  const result = await d1Query('SELECT * FROM wallet_lists ORDER BY created_at ASC');
  return Object.fromEntries(d1Rows(result).map((row) => [row.id, d1RowToList(row)]));
}

async function upsertD1List(listId, list) {
  await d1Query(
    `
      INSERT INTO wallet_lists (
        id, guild_id, name, normalized_name, channel_id, rules_json, created_by, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        guild_id = excluded.guild_id,
        name = excluded.name,
        normalized_name = excluded.normalized_name,
        channel_id = excluded.channel_id,
        rules_json = excluded.rules_json,
        created_by = excluded.created_by,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
    [
      listId,
      list.guildId,
      list.name,
      normalizeName(list.name),
      list.channelId,
      JSON.stringify(list.rules),
      list.createdBy,
      list.createdAt,
      list.updatedAt
    ]
  );
}

async function getD1List(listId) {
  const result = await d1Query('SELECT * FROM wallet_lists WHERE id = ?', [listId]);
  const row = d1Rows(result)[0];
  return row ? d1RowToList(row) : null;
}

async function findD1ListByName(guildId, name) {
  const result = await d1Query(
    'SELECT * FROM wallet_lists WHERE guild_id = ? AND normalized_name = ? LIMIT 1',
    [guildId, normalizeName(name)]
  );
  const row = d1Rows(result)[0];
  return row ? [row.id, d1RowToList(row)] : [null, null];
}

async function findD1List(guildId, nameOrId) {
  const result = await d1Query(
    `
      SELECT * FROM wallet_lists
      WHERE guild_id = ?
        AND (id = ? OR normalized_name = ?)
      LIMIT 1
    `,
    [guildId, nameOrId, normalizeName(nameOrId)]
  );
  const row = d1Rows(result)[0];
  return row ? [row.id, d1RowToList(row)] : [null, null];
}

async function getD1GuildLists(guildId) {
  const result = await d1Query(
    'SELECT * FROM wallet_lists WHERE guild_id = ? ORDER BY created_at ASC',
    [guildId]
  );
  return d1Rows(result).map((row) => [row.id, d1RowToList(row)]);
}

async function addD1WalletSubmission(listId, userId, submission, maxWallets) {
  const addressLower = submission.address.toLowerCase();
  const insertResult = await d1Query(
    `
      INSERT INTO wallet_submissions (
        id, list_id, user_id, address, address_lower, username, guild_id, submitted_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM wallet_submissions WHERE list_id = ? AND user_id = ?) < ?
        AND NOT EXISTS (
          SELECT 1 FROM wallet_submissions
          WHERE list_id = ? AND user_id = ? AND address_lower = ?
        )
    `,
    [
      randomUUID(),
      listId,
      userId,
      submission.address,
      addressLower,
      submission.username,
      submission.guildId,
      submission.submittedAt,
      listId,
      userId,
      maxWallets,
      listId,
      userId,
      addressLower
    ]
  );

  const count = await getD1UserWalletCount(listId, userId);

  if (d1Changes(insertResult) > 0) {
    return { saved: true, count };
  }

  const duplicate = await d1WalletAddressExists(listId, userId, addressLower);
  return { saved: false, reason: duplicate ? 'duplicate' : 'limit', count };
}

async function getD1UserWalletCount(listId, userId) {
  const result = await d1Query(
    'SELECT COUNT(*) AS count FROM wallet_submissions WHERE list_id = ? AND user_id = ?',
    [listId, userId]
  );
  return Number(d1Rows(result)[0]?.count ?? 0);
}

async function d1WalletAddressExists(listId, userId, addressLower) {
  const result = await d1Query(
    `
      SELECT 1 AS found FROM wallet_submissions
      WHERE list_id = ? AND user_id = ? AND address_lower = ?
      LIMIT 1
    `,
    [listId, userId, addressLower]
  );
  return d1Rows(result).length > 0;
}

async function getD1WalletEntries(listId) {
  const result = await d1Query(
    `
      SELECT user_id, address, username, guild_id, submitted_at
      FROM wallet_submissions
      WHERE list_id = ?
      ORDER BY submitted_at ASC
    `,
    [listId]
  );

  return d1Rows(result).reduce((entries, row) => {
    entries[row.user_id] ??= [];
    entries[row.user_id].push({
      address: row.address,
      username: row.username,
      userId: row.user_id,
      guildId: row.guild_id,
      submittedAt: row.submitted_at
    });
    return entries;
  }, {});
}

function d1RowToList(row) {
  return {
    id: row.id,
    name: row.name,
    guildId: row.guild_id,
    channelId: row.channel_id,
    rules: JSON.parse(row.rules_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeName(name) {
  return name.trim().toLowerCase();
}

function flattenWalletEntries(entries) {
  return Object.values(entries)
    .flat()
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

function buildCsvAttachment(rows, fileName) {
  const headers = ['user_id', 'username', 'address', 'submitted_at'];
  const lines = [
    headers.join(','),
    ...rows.map((row) =>
      [row.userId, row.username, row.address, row.submittedAt].map(escapeCsvValue).join(',')
    )
  ];

  return new AttachmentBuilder(Buffer.from(`${lines.join('\n')}\n`, 'utf8'), { name: fileName });
}

function buildJsonAttachment(rows, fileName) {
  return new AttachmentBuilder(Buffer.from(`${JSON.stringify(rows, null, 2)}\n`, 'utf8'), {
    name: fileName
  });
}

function escapeCsvValue(value) {
  const stringValue = String(value ?? '');

  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

function formatRules(rules) {
  return rules
    .map(
      (rule) =>
        `<@&${rule.roleId}>: ${rule.maxWallets} wallet${rule.maxWallets === 1 ? '' : 's'}`
    )
    .join('\n');
}

async function deferSafely(interaction) {
  if (interaction.deferred || interaction.replied) {
    return true;
  }

  try {
    await interaction.deferReply({ ephemeral: true });
    return true;
  } catch (error) {
    if (error.code === 10062 || error.code === 40060) {
      console.warn('Could not acknowledge interaction before it expired.');
      return false;
    }

    throw error;
  }
}

async function editReplySafely(interaction, response) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(response);
      return;
    }

    await interaction.reply(normalizeEphemeralResponse(response));
  } catch (error) {
    if (error.code !== 10062 && error.code !== 40060) {
      throw error;
    }
  }
}

async function respondSafely(interaction, response) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(normalizeEphemeralResponse(response));
      return;
    }

    await interaction.reply(normalizeEphemeralResponse(response));
  } catch (error) {
    if (error.code !== 10062 && error.code !== 40060) {
      throw error;
    }
  }
}

function normalizeEphemeralResponse(response) {
  if (typeof response === 'string') {
    return { content: response, ephemeral: true };
  }

  return response;
}

async function formatListSummary([listId, list]) {
  const count = flattenWalletEntries(await getWalletEntries(list.id)).length;
  const channel = list.channelId ? `<#${list.channelId}>` : 'unknown channel';

  return [
    `**${list.name}**`,
    `ID: \`${listId}\``,
    `Channel: ${channel}`,
    `Wallets: ${count}`,
    formatRules(list.rules)
  ].join('\n');
}

async function logWalletSubmission(interaction, list, address, submittedAt, count, maxWallets) {
  if (!LOG_CHANNEL_ID) {
    return;
  }

  const channel = await interaction.guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);

  if (!channel?.isTextBased()) {
    return;
  }

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle('Wallet submitted')
        .setColor(0x27ae60)
        .addFields(
          { name: 'List', value: list.name },
          { name: 'User', value: `${interaction.user} (${interaction.user.id})` },
          { name: 'Address', value: `\`${address}\`` },
          { name: 'Usage', value: `${count}/${maxWallets}` },
          { name: 'Submitted at', value: submittedAt }
        )
    ]
  });
}

async function registerSlashCommands() {
  if (!DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) {
    throw new Error('AUTO_DEPLOY_COMMANDS requires DISCORD_CLIENT_ID and DISCORD_GUILD_ID');
  }

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const route = Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID);

  await rest.put(route, { body: [walletListCommand.toJSON()] });
  console.log('Registered /wallet-list commands.');
}

client.login(DISCORD_TOKEN);
