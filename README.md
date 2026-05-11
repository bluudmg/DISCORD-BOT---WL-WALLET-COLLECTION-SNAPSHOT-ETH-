# Role-Gated ETH Wallet Bot

            ...                                                            ...                         
            ...                    .........    ..........                 ...                         
            ...                  ..........................                ...                         
            ...                 .......    .......    .......              ...                         
            ...                 .... .:::   .....:::.   .....              ...                         
            ...                 .... .::     ... ::.    .....              ...                         
         ...........            ....      :. ...     .: .....          ............                    
         ............           ......     ......      .....           .............                   
       ..............            ......:::..........:......           ..............                   
       ..............             ........................           ...............                   
       ..............               ................   ..             ..............                   
         ...........                 ..............  ...               ............                    
           .........                   ...............                    .........                    
           ..........                    ...........                     ..........                    
           .........                        .....                         ........     
           

A Discord bot for collecting ETH wallet addresses through role-gated wallet lists.

Admins can create multiple lists, choose which roles are allowed to submit, set how many wallets each role can submit, and export submissions as CSV or JSON.

## Features

- Slash commands under `/wallet-list`
- Multiple wallet lists per server
- Role-based submission access
- Per-role wallet limits
- ETH address validation
- CSV and JSON export
- Optional submission log channel
- Railway-friendly deployment
- File-based storage with optional persistent volume

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

Shows existing wallet lists and role rules.

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
```

`LOG_CHANNEL_ID` is optional. If set, every wallet submission is logged to that channel.

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
4. Add a Railway volume mounted at:

```text
/app/data
```

5. Redeploy.

The logs should show:

```text
Registered /wallet-list commands.
Logged in as YourBotName#0000
```

## Storage

The bot writes runtime data to:

```text
data/lists.json
data/wallets.json
```

These files are ignored by git because they may contain server/user data and wallet addresses.

For production hosting, use persistent storage for the `data` directory.

## License

This project is licensed under the Viral Public License. See [LICENSE](LICENSE).

Note: this license is intentionally short and viral, but it is not a standard SPDX license like MIT, GPL, or AGPL. Some package registries and GitHub tooling may show it as a custom license.

## Open Source Safety

Do not commit:

- `.env`
- bot tokens
- `data/lists.json`
- `data/wallets.json`
- exported wallet CSV/JSON files

Rotate your Discord bot token immediately if it was ever committed or shared publicly.
