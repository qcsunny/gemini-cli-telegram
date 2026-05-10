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
    .text(`${ICONS.resume} Resume`, '/resume')
    .text(`${ICONS.project} Projects`, '/projects')
    .row()
    .text(`${ICONS.clock} Schedule`, '/schedule')
    .text(`${ICONS.bot} Autopilot`, '/autopilot')
    .row()
    .text(`${ICONS.model} Model`, '/model')
    .text(`${ICONS.stats} Stats`, '/stats')
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
  
  keyboard.text(`${ICONS.search} Browse Folders`, '/project_browse').row();
  keyboard.text(`${ICONS.back} Main Menu`, '/start');
  return keyboard;
}

export function buildResumeKeyboard(sessions: Array<{ id: string; title: string; index: number }>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  
  for (const session of sessions) {
    keyboard.text(`${ICONS.resume} ${session.title.substring(0, 35)}`, `/resume ${session.index}`).row();
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
  const greeting = userName ? `Welcome back, <b>${userName}</b>!` : 'Welcome!';
  return [
    `${ICONS.sparkles} ${greeting}`,
    '',
    `I am <b>Gemini CLI</b>, your expert coding assistant and workspace companion.`,
    '',
    `<b>Available Capabilities:</b>`,
    `${ICONS.code} <b>Coding</b> — Refactor, debug, and review code`,
    `${ICONS.project} <b>Workspace</b> — Navigate and manage projects`,
    `${ICONS.bot} <b>Autopilot</b> — Autonomous problem solving`,
    `${ICONS.clock} <b>Automation</b> — Schedule recurring tasks`,
    '',
    `${ICONS.arrow} <i>Send a message or use the menu below to start.</i>`,
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
    `${ICONS.stats} <b>Session Overview</b>`,
    '',
    `<b>Configuration</b>`,
    `  ${ICONS.model} <b>Model:</b> <code>${escapeHtml(session.model)}</code>`,
    `  ${ICONS.project} <b>Project:</b> ${session.project ? `<code>${escapeHtml(session.project.name)}</code>` : 'None'}`,
    '',
    `<b>Activity</b>`,
    `  ${ICONS.session} <b>Session ID:</b> <code>${escapeHtml(session.sessionId.slice(0, 8))}</code>`,
    `  ${ICONS.clock} <b>Uptime:</b> ${minutes}m ${seconds}s`,
    `  ${ICONS.arrow} <b>Turns:</b> ${session.turnCount}`,
    `  ${ICONS.bot} <b>Active Sessions:</b> ${session.activeSessions}`,
  ].join('\n');
}

export function formatHelp(): string {
  return [
    `${ICONS.bot} <b>Gemini CLI Help Center</b>`,
    '',
    '<b>Main Commands</b>',
    `  /new — Start fresh session ${ICONS.new}`,
    `  /resume — Pick up a session ${ICONS.resume}`,
    `  /cancel — Stop AI thinking ${ICONS.cancel}`,
    `  /projects — Manage workspaces ${ICONS.project}`,
    '',
    '<b>Automation</b>',
    `  /autopilot — Autonomous mode ${ICONS.bot}`,
    `  /schedule — Recurring tasks ${ICONS.clock}`,
    '',
    '<b>Tools & Settings</b>',
    `  /model — Change AI brain ${ICONS.model}`,
    `  /compact — Optimize context ${ICONS.compact}`,
    `  /addfolder — Grant access ${ICONS.folder}`,
    `  /stats — Session metrics ${ICONS.stats}`,
    `  /help — Show this guide ${ICONS.help}`,
    '',
    '<b>Quick Tips</b>',
    `• Paste code for instant review`,
    `• Upload files for deep analysis`,
    `• Talk to me like a peer programmer`,
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
