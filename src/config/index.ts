import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const config = {
  // Server
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  apiUrl: process.env.API_URL || 'http://localhost:3000',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',

  // JWT
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  // Redis
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  // Facebook
  facebook: {
    appId: process.env.FACEBOOK_APP_ID || '',
    appSecret: process.env.FACEBOOK_APP_SECRET || '',
    redirectUri: process.env.FACEBOOK_REDIRECT_URI || 'http://localhost:3000/api/auth/facebook/callback',
    graphApiVersion: 'v21.0',
    graphApiBase: 'https://graph.facebook.com',
  },

  // Google Gemini
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  },

  // Cloudflare Workers AI
  cloudflare: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    apiToken: process.env.CLOUDFLARE_API_TOKEN || '',
    imageModel: process.env.CLOUDFLARE_IMAGE_MODEL || '@cf/stabilityai/stable-diffusion-xl-base-1.0',
  },

  // Email
  email: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || 'Auto Post <noreply@autopost.vn>',
  },

  // Encryption
  encryptionKey: process.env.ENCRYPTION_KEY || 'default-key-change-in-production!',

  // Rate limits per plan
  planLimits: {
    FREE: { maxPages: 1, maxPostsPerMonth: 10, canSchedule: false },
    PRO: { maxPages: 3, maxPostsPerMonth: 100, canSchedule: true },
    BUSINESS: { maxPages: 10, maxPostsPerMonth: -1, canSchedule: true }, // -1 = unlimited
    ENTERPRISE: { maxPages: -1, maxPostsPerMonth: -1, canSchedule: true },
  },
} as const;

export type Config = typeof config;
