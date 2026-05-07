/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../../utils/logger.js';
import {
  addAccount,
  saveAccountOAuth,
  setActiveAccount,
} from '../../config/userConfig.js';
import { ICONS } from './ui.js';

const OAUTH_CLIENT_ID = process.env['GEMINI_OAUTH_CLIENT_ID'] || '';
const OAUTH_CLIENT_SECRET = process.env['GEMINI_OAUTH_CLIENT_SECRET'] || '';
const OAUTH_REDIRECT_URI = process.env['GEMINI_OAUTH_REDIRECT_URI'] || 'https://codeassist.google.com/authcode';
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

export interface OAuthSessionData {
  codeVerifier: string;
  state: string;
  step: 'awaiting_redirect_url';
}

/**
 * Generate PKCE parameters for the OAuth flow.
 */
function generatePKCE(): {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
} {
  const codeVerifier = crypto.randomBytes(64).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  const state = crypto.randomBytes(32).toString('hex');
  return { codeVerifier, codeChallenge, state };
}

/**
 * Build the Google OAuth authorization URL with PKCE.
 */
export function buildOAuthUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    access_type: 'offline',
    scope: OAUTH_SCOPES.join(' '),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    response_type: 'code',
  });
  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

/**
 * Parse the redirect URL from the user and extract the authorization code.
 */
export function parseRedirectUrl(
  redirectUrl: string,
  expectedState: string,
): { code: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(redirectUrl);
  } catch {
    return { error: 'Invalid URL. Please paste the full redirect URL from your browser.' };
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code) {
    return { error: 'No authorization code found in the URL. Make sure you copied the full URL.' };
  }

  if (state !== expectedState) {
    return { error: 'State mismatch. Please use the authorization URL sent exactly as provided.' };
  }

  return { code };
}

/**
 * Exchange the authorization code for tokens.
 */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
): Promise<{
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expires_in: number;
}> {
  const body = new URLSearchParams({
    code,
    code_verifier: codeVerifier,
    redirect_uri: OAUTH_REDIRECT_URI,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    grant_type: 'authorization_code',
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      OAUTH_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`Token exchange failed: ${res.statusCode} ${data}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Save OAuth tokens to both the accounts directory and the global Gemini CLI location.
 */
export function saveOAuthTokens(
  accountName: string,
  tokens: {
    access_token: string;
    refresh_token: string;
    scope: string;
    token_type: string;
    expires_in: number;
  },
): void {
  const expiryDate = Date.now() + tokens.expires_in * 1000;

  const credentials = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    scope: tokens.scope,
    token_type: tokens.token_type,
    expiry_date: expiryDate,
  };

  const content = JSON.stringify(credentials, null, 2);

  // Save to accounts directory (used by the bot's config system)
  saveAccountOAuth(accountName, content);

  // Also save to the global Gemini CLI location
  const globalPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
  fs.mkdirSync(path.dirname(globalPath), { recursive: true });
  fs.writeFileSync(globalPath, content, { mode: 0o600 });

  // Register the account in the bot's config
  addAccount({ name: accountName, type: 'oauth' });
  setActiveAccount(accountName);

  logger.info(`OAuth tokens saved for account "${accountName}"`);
}

/**
 * Start the OAuth flow — generates PKCE parameters and returns the auth URL.
 * The caller should send this URL to the user and call completeOAuthFlow with the redirect URL.
 */
export function startOAuthFlow(): OAuthSessionData & { authUrl: string } {
  const { codeVerifier, codeChallenge, state } = generatePKCE();
  const authUrl = buildOAuthUrl(codeChallenge, state);
  return {
    codeVerifier,
    state,
    step: 'awaiting_redirect_url' as const,
    authUrl,
  };
}

/**
 * Complete the OAuth flow — parse the redirect URL, exchange code for tokens, and save.
 */
export async function completeOAuthFlow(
  redirectUrl: string,
  sessionData: OAuthSessionData,
  accountName: string,
): Promise<string> {
  const parsed = parseRedirectUrl(redirectUrl, sessionData.state);
  if ('error' in parsed) {
    throw new Error(parsed.error);
  }

  const tokens = await exchangeCodeForTokens(parsed.code, sessionData.codeVerifier);

  if (!tokens.refresh_token) {
    throw new Error(
      'No refresh token received. You may need to revoke access and try again:\n' +
        'https://myaccount.google.com/permissions',
    );
  }

  saveOAuthTokens(accountName, tokens);

  return accountName;
}

/**
 * Build a user-friendly message to send with the OAuth URL.
 */
export function buildOAuthMessage(authUrl: string, state: string): string {
  return [
    `${ICONS.bot} <b>Gemini Authentication Required</b>`,
    '',
    `The bot needs to authenticate with your Google account to access Gemini.`,
    '',
    `<b>Step 1:</b> Open this URL in your browser:`,
    `<a href="${authUrl}">Click here to authorize</a>`,
    '',
    `<b>Step 2:</b> Sign in with your Google account.`,
    '',
    `<b>Step 3:</b> After authorizing, you'll be redirected to a page that can't load.`,
    `<b>Copy the full URL from your browser's address bar</b> and paste it here.`,
    '',
    `The URL should start with: <code>${OAUTH_REDIRECT_URI}?code=...</code>`,
    '',
    `${ICONS.warning} This link expires in a few minutes.`,
    `State: <code>${state.slice(0, 16)}...</code>`,
  ].join('\n');
}
