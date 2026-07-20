/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { InlineKeyboard } from 'grammy';
import type { ProjectInfo } from '../../core/types.js';

// ── Emoji Constants ──
export const ICONS = {
  // General
  bot: '🤖',
  sparkles: '✨',
  terminal: '💻',
  settings: '⚙️',
  help: '💡',
  info: 'ℹ️',
  warning: '⚠️',
  error: '🚫',
  success: '✅',
  
  // Navigation & Actions
  new: '➕',
  resume: '⏯️',
  cancel: '🛑',
  arrow: '👉',
  back: '🔙',
  clock: '🕒',
  stats: '📈',
  
  // Objects
  project: '📁',
  folder: '📂',
  directory: '📂',
  file: '📄',
  model: '🧠',
  session: '🆔',
  user: '👤',
  
  // Status & Progress
  thinking: '🤔',
  loading: '⏳',
  processing: '⚙️',
  executing: '🚀',
  step: '📍',
  reasoning: '💭',
  pending: '🕒',
  done: '🏁',
  
  // Media & Tools
  tool: '🛠️',
  code: '👨‍💻',
  upload: '📤',
  download: '📥',
  compact: '🧹',
  search: '🔍',
  edit: '📝',
  save: '💾',
  trash: '🗑️',
};

// ── Inline Keyboards ──

export function buildMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(`${ICONS.new} New`, '/new')
    .text(`${ICONS.model} Model`, '/model')
    .text(`${ICONS.stats} Status`, '/status')
    .row()
    .text(`${ICONS.save} Save`, '/save')
    .text(`${ICONS.resume} Resume`, '/resume')
    .text(`${ICONS.project} Projects`, '/projects')
    .row()
    .text(`${ICONS.clock} Schedule`, '/schedule')
    .text(`${ICONS.bot} Autopilot`, '/autopilot')
    .text(`${ICONS.help} Help`, '/help');
}

export function buildModelKeyboard(models: Array<{ id: string; display: string; active?: boolean }>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const chunkSize = 1;
  
  for (let i = 0; i < models.length; i += chunkSize) {
    const chunk = models.slice(i, i + chunkSize);
    for (const model of chunk) {
      const label = `${model.active ? '● ' : '○ '}${model.display}`;
      keyboard.text(label, `/model ${model.id}`);
    }
    keyboard.row();
  }
  
  keyboard.text(`${ICONS.back} Main Menu`, '/start');
  return keyboard;
}

export function buildProjectKeyboard(projects: ProjectInfo[], hasMore = false, page = 0, currentProjectId?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  
  for (const project of projects) {
    const isActive = project.id === currentProjectId ? '● ' : '';
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
  
  keyboard.text(`${ICONS.search} Scan Documents`, '/project_scan_documents').row();
  keyboard.text(`${ICONS.back} Main Menu`, '/start');
  return keyboard;
}

function getVisualWidth(str: string): number {
  let width = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code >= 0x4e00 && code <= 0x9fa5) || (code >= 0xff00 && code <= 0xffef)) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function truncateToWidth(str: string, maxWidth: number): string {
  if (getVisualWidth(str) <= maxWidth) return str;
  let currentWidth = 0;
  let res = '';
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const code = char.charCodeAt(0);
    const charWidth = ((code >= 0x4e00 && code <= 0x9fa5) || (code >= 0xff00 && code <= 0xffef)) ? 2 : 1;
    if (currentWidth + charWidth + 2 > maxWidth) {
      return res + '…';
    }
    currentWidth += charWidth;
    res += char;
  }
  return res + '…';
}

export function buildResumeKeyboard(sessions: Array<{ id: string; title: string; index: number; relativeTime?: string }>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  
  for (const session of sessions) {
    const rawTitle = (session.title || session.id.slice(0, 8)).trim();
    const timeTag = session.relativeTime ? ` (${session.relativeTime})` : '';
    const prefix = `${session.index}. `;
    
    // Total visual width target = 38 (equivalent to 19 Chinese characters)
    const availableWidthForTitle = 38 - getVisualWidth(prefix) - getVisualWidth(timeTag);
    const cleanTitle = truncateToWidth(rawTitle, Math.max(10, availableWidthForTitle));

    keyboard.text(`${prefix}${cleanTitle}${timeTag}`, `/resume ${session.index}`).row();
  }
  
  keyboard.text(`${ICONS.back} Main Menu`, '/start');
  return keyboard;
}

export function buildConfirmationKeyboard(action: string, data: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(`${ICONS.success} Confirm`, `${action}_confirm ${data}`)
    .text(`${ICONS.cancel} Cancel`, '/start');
}

// ── Message Formatting ──

export function formatWelcome(userName?: string): string {
  const greeting = userName ? `Welcome back, <b>${escapeHtml(userName)}</b>!` : 'Welcome!';
  return [
    `${ICONS.sparkles} <b>${greeting}</b>`,
    '',
    `I am <b>Gemini CLI</b>, your autonomous AI coding and workspace companion.`,
    '',
    `<b>Core Capabilities & Features:</b>`,
    `${ICONS.model} <b>Native 10.2 Streaming</b> — Collapsible thinking blocks & rich formatting`,
    `${ICONS.code} <b>Deep Refactoring</b> — Code analysis, debugging & system architecture`,
    `${ICONS.project} <b>Workspace Manager</b> — Effortless project & folder navigation`,
    `${ICONS.save} <b>Obsidian Integration</b> — Save responses directly with /save`,
    `${ICONS.clock} <b>Automated Tasks</b> — Schedule one-shot and recurring cron tasks`,
    '',
    `${ICONS.arrow} <i>Send a prompt to begin, or use the menu below:</i>`,
  ].join('\n');
}

export function formatProjectInfo(project: ProjectInfo): string {
  return [
    `${ICONS.project} <b>${escapeHtml(project.name)}</b>`,
    `  ${ICONS.directory} <code>${escapeHtml(project.path)}</code>`,
    project.description ? `  ${ICONS.info} <i>${escapeHtml(project.description)}</i>` : '',
    project.lastUsed ? `  ${ICONS.clock} Last active: ${formatRelativeTime(project.lastUsed)}` : '',
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
    `${ICONS.stats} <b>Session Overview & Metrics</b>`,
    '',
    `<b>Configuration</b>`,
    `  ${ICONS.model} <b>Active Brain:</b> <code>${escapeHtml(session.model)}</code>`,
    `  ${ICONS.project} <b>Workspace:</b> ${session.project ? `<code>${escapeHtml(session.project.name)}</code>` : 'None'}`,
    '',
    `<b>Activity Metrics</b>`,
    `  ${ICONS.session} <b>Session ID:</b> <code>${escapeHtml(session.sessionId.slice(0, 8))}...</code>`,
    `  ${ICONS.clock} <b>Uptime:</b> ${minutes}m ${seconds}s`,
    `  ${ICONS.arrow} <b>Conversation Turns:</b> ${session.turnCount}`,
    `  ${ICONS.bot} <b>Active Sessions:</b> ${session.activeSessions}`,
  ].join('\n');
}

export function formatHelp(): string {
  return [
    `${ICONS.bot} <b>Gemini CLI Help Center</b>`,
    '',
    '<b>Core Commands</b>',
    `  /new — Start a fresh session ${ICONS.new}`,
    `  /resume — Restore previous conversation ${ICONS.resume}`,
    `  /cancel — Stop AI generation ${ICONS.cancel}`,
    `  /save — Export response as Obsidian-compatible Markdown ${ICONS.save}`,
    `  /projects — Switch & manage workspaces ${ICONS.project}`,
    '',
    '<b>Automation</b>',
    `  /autopilot — Autonomous problem solving ${ICONS.bot}`,
    `  /schedule — Manage recurring & timed tasks ${ICONS.clock}`,
    '',
    '<b>Models & Settings</b>',
    `  /model — Change AI model ${ICONS.model}`,
    `  /status — View session metrics ${ICONS.stats}`,
    `  /help — Show command reference ${ICONS.help}`,
    '',
    '<b>Pro Tips</b>',
    `• Supports Telegram 10.2 native collapsible thinking blocks`,
    `• Paste code snippets or upload files for deep analysis`,
    `• Use /new to clear conversation history and reset context`,
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

// ── Status Formatting ──

export interface ToolStatus {
  name: string;
  status: 'pending' | 'running' | 'success' | 'error';
  error?: string;
}

export function formatThinkingStatus(currentStatus: string, details?: string): string {
  return `${ICONS.thinking} <b>AI is thinking...</b>\n${ICONS.step} ${currentStatus}${details ? `\n   └ <i>${details}</i>` : ''}`;
}

export function formatToolExecution(tools: ToolStatus[]): string {
  if (tools.length === 0) return '';

  const statusIcon = (status: ToolStatus['status']): string => {
    switch (status) {
      case 'pending': return ICONS.pending;
      case 'running': return ICONS.executing;
      case 'success': return ICONS.success;
      case 'error': return ICONS.error;
    }
  };

  const lines = tools.map(tool => {
    const icon = statusIcon(tool.status);
    const name = tool.name.length > 40 ? tool.name.substring(0, 37) + '...' : tool.name;
    if (tool.status === 'error' && tool.error) {
      const errorMsg = tool.error.length > 50 ? tool.error.substring(0, 47) + '...' : tool.error;
      return `${icon} <code>${name}</code>\n   └ ${ICONS.error} <i>${errorMsg}</i>`;
    }
    return `${icon} <code>${name}</code>`;
  });

  return [
    `${ICONS.processing} <b>Executing ${tools.length} tool(s)</b>`,
    '',
    ...lines,
  ].join('\n');
}

export function formatStepProgress(currentStep: number, totalSteps: number, stepName?: string): string {
  const progress = '█'.repeat(currentStep) + '░'.repeat(totalSteps - currentStep);
  return `${ICONS.processing} <b>Step ${currentStep}/${totalSteps}</b> <code>${progress}</code>${stepName ? `\n${ICONS.step} ${stepName}` : ''}`;
}

export function formatReasoningStatus(reasoning?: string): string {
  return `${ICONS.reasoning} <b>Analyzing context...</b>${reasoning ? `\n   └ <i>${reasoning.substring(0, 100)}${reasoning.length > 100 ? '...' : ''}</i>` : ''}`;
}
