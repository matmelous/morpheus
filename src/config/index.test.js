import test from 'node:test';
import assert from 'node:assert/strict';
import { config, validateConfig } from './index.js';

test('validateConfig allows Discord-only startup without WhatsApp numbers', () => {
  const prev = {
    whatsappEnabled: config.whatsappEnabled,
    allowedPhoneNumbers: [...config.allowedPhoneNumbers],
    discordEnabled: config.discord.enabled,
    discordBotToken: config.discord.botToken,
    discordAllowedGuildIds: [...config.discord.allowedGuildIds],
  };

  config.whatsappEnabled = false;
  config.allowedPhoneNumbers = [];
  config.discord.enabled = true;
  config.discord.botToken = 'discord-token';
  config.discord.allowedGuildIds = ['guild-1'];

  assert.doesNotThrow(() => validateConfig());

  config.whatsappEnabled = prev.whatsappEnabled;
  config.allowedPhoneNumbers = prev.allowedPhoneNumbers;
  config.discord.enabled = prev.discordEnabled;
  config.discord.botToken = prev.discordBotToken;
  config.discord.allowedGuildIds = prev.discordAllowedGuildIds;
});

test('validateConfig still requires WhatsApp numbers when WhatsApp is enabled', () => {
  const prev = {
    whatsappEnabled: config.whatsappEnabled,
    allowedPhoneNumbers: [...config.allowedPhoneNumbers],
  };

  config.whatsappEnabled = true;
  config.allowedPhoneNumbers = [];

  assert.throws(
    () => validateConfig(),
    /ALLOWED_PHONE_NUMBERS must contain at least one phone number when WHATSAPP_ENABLED=true/
  );

  config.whatsappEnabled = prev.whatsappEnabled;
  config.allowedPhoneNumbers = prev.allowedPhoneNumbers;
});
