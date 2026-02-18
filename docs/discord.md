# Discord Guide (Morpheus)

Este guia cobre toda a configuracao e operacao do Morpheus no Discord:

- conectar o bot em um ou mais servidores
- liberar guilds no `.env`
- habilitar canais especificos para task fixa
- entender `DISCORD_INSTANCE_ID`
- validar que o bot esta funcionando

## Como funciona no Morpheus

- Um bot (Discord App) pode entrar em varios servidores.
- O Morpheus so processa mensagens de guilds permitidas em `DISCORD_ALLOWED_GUILD_IDS`.
- Em cada guild permitida, cada canal comeca desabilitado.
- Um admin habilita o canal com `/channel-enable`.
- Cada canal habilitado tem contexto proprio (task fixa por canal).
- Canais nao habilitados ficam em silencio (sem resposta no chat).

## 1) Criar/usar o Discord App (bot)

1. Abra o [Discord Developer Portal](https://discord.com/developers/applications).
2. Selecione seu app existente (ou crie um novo).
3. Em `Bot`, copie o token.
4. Em `Bot > Privileged Gateway Intents`, habilite `Message Content Intent`.

## 2) Convidar o bot para um servidor

1. No app, abra `OAuth2 > URL Generator`.
2. Em `Scopes`, marque `bot`.
3. Em `Bot Permissions`, marque pelo menos:
   - `View Channels`
   - `Send Messages`
   - `Read Message History`
4. Abra a URL gerada e escolha o servidor.

## 3) Pegar Guild ID e User ID

1. No Discord, ative `User Settings > Advanced > Developer Mode`.
2. `Guild ID`: clique com botao direito no nome do servidor -> `Copy Server ID`.
3. `User ID`: clique com botao direito no seu usuario -> `Copy User ID`.

## 4) Configurar `.env`

Arquivo: `/Users/matheus/development/development/morpheus/.env`

```env
DISCORD_ENABLED=true
DISCORD_BOT_TOKEN=SEU_TOKEN
DISCORD_ALLOWED_GUILD_IDS=111111111111111111,222222222222222222
DISCORD_ADMIN_USER_IDS=999999999999999999
DISCORD_INSTANCE_ID=morpheus-discord
DISCORD_MESSAGE_MAX_LENGTH=1900
```

Notas:

- `DISCORD_ALLOWED_GUILD_IDS`: pode conter varios servidores (CSV).
- `DISCORD_ADMIN_USER_IDS`: usuarios que podem executar comandos admin no Discord.
- `DISCORD_INSTANCE_ID`: identificador interno para deduplicacao de mensagens.
  - Nao vem do Discord.
  - Pode manter `morpheus-discord`.
  - So mude se rodar multiplas instancias do Morpheus no mesmo banco.

## 5) Reiniciar o Morpheus

No diretorio do projeto:

```bash
npm run dev
```

Nos logs, confirme que o cliente Discord conectou.

## 6) Habilitar canais (task fixa por canal)

No canal que deve operar tasks:

```text
/channel-enable
```

Opcionalmente, ja definindo projeto e runner:

```text
/channel-enable <projectId> <runnerKind>
```

Exemplo:

```text
/channel-enable morpheus codex-cli
```

Comandos uteis:

- `/channel-info` -> mostra status do canal, task foco, projeto e runner
- `/channel-disable` -> desabilita o canal
- `/new` -> reseta a task do canal (cria nova task foco)

## 7) Um bot em varios servidores

Pode usar o mesmo Discord App/Bot em varios servidores:

1. Convide o bot em cada servidor.
2. Adicione os novos guild IDs em `DISCORD_ALLOWED_GUILD_IDS`.
3. Reinicie o Morpheus.
4. Rode `/channel-enable` nos canais desejados de cada servidor.

## 8) Comportamento importante

- O bot nao roda automaticamente em todos os canais.
- Apenas canais habilitados com `/channel-enable` processam mensagens.
- Canais nao habilitados ficam em silencio.
- WhatsApp continua funcionando em paralelo.

## 9) Troubleshooting rapido

- Bot online e sem responder em nenhum lugar:
  - confira `DISCORD_ENABLED=true`
  - confira `DISCORD_BOT_TOKEN`
  - confira `DISCORD_ALLOWED_GUILD_IDS`
  - confira `Message Content Intent` habilitado
- Responde em um servidor e ignora outro:
  - faltou incluir o guild ID novo no `.env`
- Comando admin negado:
  - seu user ID nao esta em `DISCORD_ADMIN_USER_IDS`
- Duplicidade de resposta:
  - evite duas instancias do Morpheus rodando com o mesmo token ao mesmo tempo
