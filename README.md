# Role-Gated ETH Wallet Bot

A Discord bot for collecting ETH wallet addresses through role-gated wallet lists.

Admins can create multiple lists, choose which roles are allowed to submit, set how many wallets each role can submit, and export submissions as CSV or JSON.

## Features

- Slash commands under `/wallet-list`
- Multiple wallet lists per server
- Role-based submission access
- Per-role wallet limits
- ETH address validation
- CSV and JSON export
- List deletion
- Optional submission log channel
- Railway-friendly deployment
- Cloudflare D1 production storage
- Local JSON storage for simple/local installs

## Commands

### `/wallet-list create`

Creates a wallet list and posts a submission button.

Options:

- `name`: list name, for example `Presale`
- `role_1`: first role allowed to submit
- `max_1`: wallet limit for `role_1`
- `role_2` through `role_5`: optional additional roles
- `max_2` through `max_5`: optional limits for additional roles
- `channel`: optional channel where the button should be posted

If a member has multiple allowed roles, the bot uses the highest matching wallet limit.

### `/wallet-list rules`

Replaces the role rules for an existing list.

### `/wallet-list export`

Exports one list as CSV or JSON.

CSV columns:

```text
user_id,username,address,submitted_at
```

### `/wallet-list show`

Shows existing wallet lists, list IDs, channels, wallet counts, and role rules. Empty lists show with `0` wallets.

### `/wallet-list panel`

Posts a fresh submission button for an existing list.

Options:

- `name`: existing list name or list ID
- `channel`: optional channel where the fresh button should be posted

Use this if an old button says `This wallet list is no longer configured` but the list still appears in `/wallet-list show`.

### `/wallet-list delete`

Deletes an existing wallet list and its saved wallet submissions.

Options:

- `name`: existing list name or list ID

Old buttons for the deleted list will stop working.

## Discord Permissions

Invite the bot with these scopes:

- `bot`
- `applications.commands`

Recommended bot permissions:

- View Channel
- Send Messages
- Read Message History
- Use Application Commands

For private or role-locked channels, add the bot or bot role in channel permissions and allow it to view and send messages in the channel where the wallet button should be posted.

Admin commands require `Manage Server`.

## Environment Variables

Copy `.env.example` to `.env` for local use, or add these variables to your host:

```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_application_client_id_here
DISCORD_GUILD_ID=your_server_id_here
AUTO_DEPLOY_COMMANDS=true
LOG_CHANNEL_ID=
STORAGE_DRIVER=d1
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_D1_DATABASE_ID=
CLOUDFLARE_API_TOKEN=
D1_IMPORT_JSON_ON_START=false
```

`LOG_CHANNEL_ID` is optional. If set, every wallet submission is logged to that channel.

For professional wallet collection, use `STORAGE_DRIVER=d1`. Local JSON files are fine for testing, but they are not the safest storage for production allowlists.

## Local Development

```bash
npm install
npm run deploy
npm start
```

## Railway Deployment

1. Create a new Railway project from this GitHub repo.
2. Add the environment variables listed above.
3. Set `AUTO_DEPLOY_COMMANDS=true`.
4. For production, create a Cloudflare D1 database and add the D1 variables listed above.
5. Redeploy.

The logs should show:

```text
Registered /wallet-list commands.
Logged in as YourBotName#0000
```

## Storage

The bot supports two storage modes:

### Cloudflare D1

Recommended for production.

Set:

```env
STORAGE_DRIVER=d1
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
CLOUDFLARE_D1_DATABASE_ID=your_d1_database_id
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token
```

The bot automatically creates the required D1 tables on startup:

- `wallet_lists`
- `wallet_submissions`

To migrate existing local JSON data into D1, set this for one deploy:

```env
D1_IMPORT_JSON_ON_START=true
```

After confirming the data is imported, set it back to:

```env
D1_IMPORT_JSON_ON_START=false
```

### Local JSON

If `STORAGE_DRIVER` is not `d1`, the bot writes runtime data to:

```text
data/lists.json
data/wallets.json
```

These files are ignored by git because they may contain server/user data and wallet addresses.

For production hosting with JSON storage, use persistent storage for the `data` directory. For serious allowlists, D1 is recommended instead.

## License

This project is licensed under the Viral Public License. See [LICENSE](LICENSE).

Note: this license is intentionally short and viral, but it is not a standard SPDX license like MIT, GPL, or AGPL. Some package registries and GitHub tooling may show it as a custom license.

## Open Source Safety

Do not commit:

- `.env`
- bot tokens
- Cloudflare API tokens
- `data/lists.json`
- `data/wallets.json`
- exported wallet CSV/JSON files

Rotate your Discord bot token immediately if it was ever committed or shared publicly.
