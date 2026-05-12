# Cloud Deployment Guide

This bot is meant to run continuously. For a simple no-local setup, Railway is the easiest path.

## Recommended: Railway

### 1. Put the bot on GitHub

Create a GitHub repository and upload this project.

Do not upload `.env`. The `.gitignore` already blocks it.

### 2. Create the Discord bot

In <https://discord.com/developers/applications>:

1. Create an application.
2. Add a bot.
3. Copy the bot token.
4. Copy the application/client ID.
5. Invite the bot using the scopes `bot` and `applications.commands`.

Recommended bot permissions:

- Send Messages
- Use Slash Commands
- Read Message History

### 3. Create a Railway project

1. Go to <https://railway.com>.
2. Create a new project.
3. Choose deploy from GitHub.
4. Select the bot repository.

Railway will install dependencies and run `npm start`.

### 4. Add environment variables

In the Railway service, open the Variables tab and add:

```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_application_client_id_here
DISCORD_GUILD_ID=your_server_id_here
AUTO_DEPLOY_COMMANDS=true
LOG_CHANNEL_ID=
STORAGE_DRIVER=d1
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
CLOUDFLARE_D1_DATABASE_ID=your_d1_database_id
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token
D1_IMPORT_JSON_ON_START=false
```

`LOG_CHANNEL_ID` is optional.

### 5. Add Cloudflare D1 storage

For professional wallet collection, use Cloudflare D1 instead of Railway local files.

1. In Cloudflare, create a D1 database.
2. Copy the Account ID.
3. Copy the D1 Database ID.
4. Create a Cloudflare API token that can edit D1.
5. Add the variables above in Railway.

The bot creates its own D1 tables at startup.

If you already collected wallets in local JSON files, you can import them once by setting:

```env
D1_IMPORT_JSON_ON_START=true
```

Deploy once, confirm the import in Railway logs, then set it back to:

```env
D1_IMPORT_JSON_ON_START=false
```

Do not leave the import switch on forever.

### Optional: local JSON storage

For testing only, you can use:

```env
STORAGE_DRIVER=json
```

If you use JSON storage on Railway, attach a Volume to the service and mount it at `/app/data`.

### 6. Deploy

After variables and the volume are set, deploy/redeploy the service.

When it starts, the logs should show:

```text
Registered /wallet-list commands.
Storage: Cloudflare D1.
Logged in as YourBotName#0000
```

Then Discord will show:

```text
/wallet-list create
/wallet-list rules
/wallet-list export
/wallet-list show
```

## Updating The Bot Later

Push changes to GitHub. Railway will redeploy from the latest version.

If you change slash commands, keep:

```env
AUTO_DEPLOY_COMMANDS=true
```

That lets the hosted bot update the Discord command list when it starts.
