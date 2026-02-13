# WhatsApp Media (Standalone)

Este projeto nao depende de `backend-whatsapp-api` para enviar/baixar midia.

Toda a troca de mensagens e arquivos roda internamente via Baileys (`@whiskeysockets/baileys`).

## Como funciona

- Envio de texto/imagem: `src/services/whatsapp.js` (`sendMessage`, `sendImage`)
- Recebimento de audio/imagem: listener `messages.upsert` do Baileys
- Download da midia recebida: `downloadMediaMessage` (Baileys)

## Fluxo de midia recebida

1. Mensagem chega no socket Baileys.
2. O payload interno e roteado para `src/routes/webhook.js`.
3. A midia e baixada e salva em `RUNS_DIR/<taskId>/inbox/<messageId>/`.
4. Audio e transcrito (OpenAI Whisper) e imagem e descrita (OpenRouter multimodal).
5. O resultado vira texto canonico para o orquestrador.

## Observacao

O endpoint HTTP `/webhook` continua disponivel apenas para compatibilidade, mas o modo recomendado e standalone via Baileys.
