/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { InlineKeyboard } from 'grammy';
import type { ProjectInfo } from '../../core/types.js';

// ── Emoji Constants ──
export const ICONS = {
  bot: '🤖',
  thinking: '🧠',
  tool: '🔧',
  toolSuccess: '✅',
  toolError: '❌',
  toolRunning: '⏳',
  project: '📁',
  model: '🎯',
  new: '🆕',
  cancel: '🛑',
  resume: '▶️',
  compact: '📦',
  stats: '📊',
  help: '❓',
  folder: '📂',
  loading: '⏳',
  done: '✅',
  warning: '⚠️',
  error: '❌',
  info: 'ℹ️',
  arrow: '➡️',
  sparkles: '✨',
  clock: '🕐',
  user: '👤',
  session: '🔑',
  directory: '📂',
  code: '💻',
  send: '📤',
};

// ── Inline Keyboards ──

export function buildMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(`${ICONS.new} New Session`, '/new')
    .text(`${ICONS.project} Projects`, '/projects')
    .row()
    .text(`${ICONS.clock} Schedule`, '/schedule')
    .text(`${ICONS.bot} Autopilot`, '/autopilot')
    .row()
    .text(`${ICONS.model} Model`, '/model')
    .text(`${ICONS.resume} Resume`, '/resume')
    .row()
    .text(`${ICONS.stats} Stats`, '/stats')
    .text(`${ICONS.help} Help`, '/help');
}

export function buildModelKeyboard(models: Array<{ id: string; display: string; active?: boolean }>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const chunkSize = 2;
  
  for (let i = 0; i < models.length; i += chunkSize) {
    const chunk = models.slice(i, i + chunkSize);
    for (const model of chunk) {
      const label = `${model.active ? '✓ ' : ''}${model.display}`;
      keyboard.text(label, `/model ${model.id}`);
    }
    keyboard.row();
  }
  
  keyboard.text('« Back', '/start');
  return keyboard;
}

export function buildProjectKeyboard(projects: ProjectInfo[], hasMore = false, page = 0, currentProjectId?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  
  for (const project of projects) {
    const isActive = project.id === currentProjectId ? '✓ ' : '';
    const label = `${isActive}${ICONS.project} ${project.name}`;
    keyboard.text(label, `/project_select ${project.id}`).row();
  }
  
  const navRow: Array<{ text: string; callback: string }> = [];
  if (page > 0) {
    navRow.push({ text: '« Prev', callback: `/projects_page ${page - 1}` });
  }
  if (hasMore) {
    navRow.push({ text: 'Next »', callback: `/projects_page ${page + 1}` });
  }
  
  if (navRow.length > 0) {
    for (const btn of navRow) {
      keyboard.text(btn.text, btn.callback);
    }
    keyboard.row();
  }
  
  keyboard.text(`${ICONS.directory} Browse...`, '/project_browse').row();
  keyboard.text('« Back', '/start');
  return keyboard;
}

export function buildResumeKeyboard(sessions: Array<{ id: string; title: string; index: number }>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  
  for (const session of sessions) {
    keyboard.text(`${ICONS.resume} ${session.title.substring(0, 40)}`, `/resume ${session.index}`).row();
  }
  
  keyboard.text('« Back', '/start');
  return keyboard;
}

export function buildConfirmationKeyboard(action: string, data: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(`${ICONS.done} Yes`, `${action}_confirm ${data}`)
    .text(`${ICONS.cancel} Cancel`, '/start');
}

// ── Message Formatting ──

export function formatWelcome(userName?: string): string {
  const greeting = userName ? `Hello, ${userName}!` : 'Hello!';
  return [
    `${ICONS.sparkles} <b>${greeting}</b>`,
    '',
    `${ICONS.bot} Welcome to <b>Gemini CLI Telegram Bot</b>`,
    '',
    'I can help you with:',
    `  ${ICONS.code} Coding & development`,
    `  ${ICONS.project} Project management`,
    `  ${ICONS.directory} File operations`,
    `  ${ICONS.tool} Tool execution`,
    '',
    `${ICONS.arrow} Send me a message to get started, or use the buttons below.`,
  ].join('\n');
}

export function formatProjectInfo(project: ProjectInfo): string {
  return [
    `${ICONS.project} <b>${project.name}</b>`,
    `  ${ICONS.directory} Path: <code>${project.path}</code>`,
    project.description ? `  ${ICONS.info} ${project.description}` : '',
    project.lastUsed ? `  ${ICONS.clock} Last used: ${formatRelativeTime(project.lastUsed)}` : '',
  ].filter(Boolean).join('\n');
}

export function formatSessionStats(session: {
  sessionId: string;
  model: string;
  turnCount: number;
  createdAt: Date;
  project?: ProjectInfo;
  activeSessions: number;
}): string {
  const uptime = Math.floor((Date.now() - session.createdAt.getTime()) / 1000);
  const minutes = Math.floor(uptime / 60);
  const seconds = uptime % 60;
  
  return [
    `${ICONS.stats} <b>Session Statistics</b>`,
    '',
    `  ${ICONS.session} Session: <code>${session.sessionId.slice(0, 8)}...</code>`,
    `  ${ICONS.model} Model: <code>${session.model}</code>`,
    `  ${ICONS.project} Project: ${session.project ? session.project.name : 'Default'}`,
    `  ${ICONS.clock} Duration: ${minutes}m ${seconds}s`,
    `  ${ICONS.arrow} Turns: ${session.turnCount}`,
    `  ${ICONS.bot} Active sessions: ${session.activeSessions}`,
  ].join('\n');
}

export function formatHelp(): string {
  return [
    `${ICONS.bot} <b>Gemini CLI Telegram Bot</b>`,
    '',
    '<b>Commands:</b>',
    `  ${ICONS.new} /new — Start a fresh session`,
    `  ${ICONS.cancel} /cancel — Cancel current operation`,
    `  ${ICONS.project} /projects — Browse and select projects`,
    `  ${ICONS.clock} /schedule — Schedule one-time or recurring messages`,
    `  ${ICONS.bot} /autopilot — AI auto-works on a goal (max 10 iterations)`,
    `  ${ICONS.resume} /resume — List or resume a previous session`,
    `  ${ICONS.model} /model — Switch AI model`,
    `  ${ICONS.compact} /compact — Compress chat history`,
    `  ${ICONS.folder} /addfolder — Add folder for read+write access`,
    `  ${ICONS.stats} /stats — Show session statistics`,
    `  ${ICONS.session} /id — Show current session ID`,
    `  ${ICONS.help} /help — Show this help message`,
    '',
    '<b>Features:</b>',
    `  ${ICONS.code} Send code snippets for review`,
    `  ${ICONS.directory} Share files and documents`,
    `  ${ICONS.tool} Auto tool execution`,
    `  ${ICONS.clock} Schedule recurring tasks`,
    `  ${ICONS.bot} Autopilot / self-reply mode`,
    '',
    `${ICONS.arrow} Send any message to start chatting!`,
  ].join('\n');
}

// ── Utilities ──

function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}
