import 'dotenv/config';

const need = (key) => {
  if (process.env[key] === undefined || process.env[key] === '') {
    console.error(`В .env не задано: ${key}`);
    process.exit(1);
  }
  return process.env[key];
};

export const BOT_TOKEN = need('BOT_TOKEN');
export const OWNER_ID = Number(need('OWNER_ID'));
export const VAULT_PATH = need('VAULT_PATH');
export const TIMEZONE = process.env.TIMEZONE || 'Europe/Kyiv';
export const DAY_START_HOUR = Number(process.env.DAY_START_HOUR ?? 4);
export const DEFAULT_CURRENCY = (process.env.DEFAULT_CURRENCY || 'UAH').toUpperCase();
export const API_ROOT = process.env.API_ROOT || '';
export const BOT_API_DOCKER_DIR = process.env.BOT_API_DOCKER_DIR || '';
export const BOT_API_HOST_DIR = process.env.BOT_API_HOST_DIR || '';
export const BOT_API_CONTAINER = process.env.BOT_API_CONTAINER || 'telegram-bot-api';
