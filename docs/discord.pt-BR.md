# Guia do Discord (Morpheus)

Idioma: [English](discord.md) | **Português (pt-BR)**

Este guia cobre toda a configuração e operação do Morpheus no Discord:

- conectar o bot em um ou mais servidores;
- liberar guilds no `.env`;
- registrar slash commands nativos;
- habilitar canais específicos para task fixa;
- enviar e receber mídia (imagem/áudio/arquivo);
- entender `DISCORD_INSTANCE_ID`;
- validar que o bot está funcionando.

## Como funciona no Morpheus

- Um bot (Discord App) pode entrar em vários servidores.
- O Morpheus só processa mensagens de guilds permitidas em `DISCORD_ALLOWED_GUILD_IDS`.
- Os slash commands nativos são registrados automaticamente para cada guild permitida quando o Morpheus inicia.
- `channel-enable` oferece autocomplete para projeto e runner.
- Em cada guild permitida, cada canal começa desabilitado.
- Um admin habilita o canal com `/channel-enable`.
- Cada canal habilitado tem contexto próprio (task fixa por canal).
- Canais não habilitados ficam em silêncio (sem resposta no chat).

## 1) Criar/usar o Discord App (bot)

1. Abra o [Discord Developer Portal](https://discord.com/developers/applications).
2. Selecione seu app existente (ou crie um novo).
3. Em `Bot`, copie o token.
4. Em `Bot > Privileged Gateway Intents`, habilite `Message Content Intent`.

## 2) Convidar o bot para um servidor

1. No app, abra `OAuth2 > URL Generator`.
2. Em `Scopes`, marque `bot` e `applications.commands`.
3. Em `Bot Permissions`, marque pelo menos:
   - `View Channels`
   - `Send Messages`
   - `Attach Files`
   - `Read Message History`
4. Abra a URL gerada e escolha o servidor.

## 3) Pegar Guild ID e User ID

1. No Discord, ative `User Settings > Advanced > Developer Mode`.
2. `Guild ID`: clique com botão direito no nome do servidor -> `Copy Server ID`.
3. `User ID`: clique com botão direito no seu usuário -> `Copy User ID`.

## 4) Configurar `.env`

Arquivo: `<raiz-do-morpheus>/.env`

```env
DISCORD_ENABLED=true
DISCORD_BOT_TOKEN=SEU_TOKEN
DISCORD_ALLOWED_GUILD_IDS=111111111111111111,222222222222222222
DISCORD_ADMIN_USER_IDS=999999999999999999
DISCORD_INSTANCE_ID=morpheus-discord
DISCORD_MESSAGE_MAX_LENGTH=1900
DISCORD_MEDIA_MAX_BYTES=8388608
WHATSAPP_ENABLED=false
```

Notas:

- `DISCORD_ALLOWED_GUILD_IDS`: pode conter vários servidores (CSV).
- `DISCORD_ADMIN_USER_IDS`: usuários que podem executar comandos admin no Discord.
- `DISCORD_MEDIA_MAX_BYTES`: tamanho máximo de anexo para upload/download no Discord (default: 8 MB).
- `WHATSAPP_ENABLED=false`: opcional, útil quando você quer rodar só com Discord.
- `DISCORD_INSTANCE_ID`: identificador interno para deduplicação de mensagens.
  - Não vem do Discord.
  - Pode manter `morpheus-discord`.
  - Só mude se rodar múltiplas instâncias do Morpheus no mesmo banco.

## 5) Reiniciar o Morpheus

No diretório do projeto:

```bash
npm run dev
```

Nos logs, confirme que o cliente Discord conectou.
Ao iniciar, o Morpheus registra os slash commands para cada guild listada em `DISCORD_ALLOWED_GUILD_IDS`.

## 6) Habilitar canais (task fixa por canal)

No canal que deve operar tasks:

```text
/channel-enable
```

Opcionalmente, já definindo projeto e runner. Os dois campos têm autocomplete no Discord:

```text
/channel-enable <projectId> <runnerKind>
```

Exemplo:

```text
/channel-enable morpheus codex-cli
```

Comandos úteis:

- `/channel-info` -> mostra status do canal, task foco, projeto e runner.
- `/channel-disable` -> desabilita o canal.
- `/new` -> reseta a task do canal (cria nova task foco).
- `/projects` -> lista os projetos disponíveis.
- `/project` -> mostra ou altera o projeto atual.
- `/task` -> mostra ou altera a task em foco.

## 7) Um bot em vários servidores

Pode usar o mesmo Discord App/Bot em vários servidores:

1. Convide o bot em cada servidor.
2. Adicione os novos guild IDs em `DISCORD_ALLOWED_GUILD_IDS`.
3. Reinicie o Morpheus para registrar os slash commands nas novas guilds.
4. Rode `/channel-enable` nos canais desejados de cada servidor.

## 8) Comportamento importante

- O bot não roda automaticamente em todos os canais.
- Apenas canais habilitados com `/channel-enable` processam mensagens.
- Canais não habilitados ficam em silêncio.
- Slash commands são a entrada principal. Os comandos em texto continuam compatíveis onde ainda forem suportados.
- Envio de mídia no Discord é suportado (imagem/áudio/arquivo), com fallback em texto quando upload falha.
- Anexos recebidos no Discord são processados junto do texto (exceto comandos com `/`).
- O WhatsApp só roda em paralelo quando `WHATSAPP_ENABLED=true`.

## 9) Troubleshooting rápido

- Bot online e sem responder em nenhum lugar:
  - confira `DISCORD_ENABLED=true`;
  - confira `DISCORD_BOT_TOKEN`;
  - confira `DISCORD_ALLOWED_GUILD_IDS`;
  - confira `Message Content Intent` habilitado.
- Slash commands não aparecem no Discord:
  - reinicie o Morpheus depois de atualizar `DISCORD_ALLOWED_GUILD_IDS`;
  - confirme que o bot está instalado na guild;
  - se necessário, reinstale o bot com o scope `applications.commands`;
  - confirme nos logs que o registro dos comandos foi concluído.
- Responde em um servidor e ignora outro:
  - faltou incluir o guild ID novo no `.env`.
- Comando admin negado:
  - seu user ID não está em `DISCORD_ADMIN_USER_IDS`.
- Duplicidade de resposta:
  - evite duas instâncias do Morpheus rodando com o mesmo token ao mesmo tempo.
- Falha de upload/download de anexo:
  - confira `DISCORD_MEDIA_MAX_BYTES` e permissão do canal para anexar arquivos.
