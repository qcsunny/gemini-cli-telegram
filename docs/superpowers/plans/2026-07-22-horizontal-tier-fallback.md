# Horizontal Tier-First Circular Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the model fallback system to a horizontal tier-first circular queue.

**Architecture:** Replace the legacy channel fallback structures with a single prioritized `ORDERED_MODELS` list. Traversal is rewritten to collect fallback options as a circular loop from the starting model down to the end, then wrapping back to index 0 up to `idx - 1`.

**Tech Stack:** TypeScript, Node.js, Vitest

## Global Constraints

*   Target files: [src/core/messageLoop.ts](src/core/messageLoop.ts) and [src/core/messageLoop.test.ts](src/core/messageLoop.test.ts).
*   No other files should be affected. All existing tests (152 total) must pass.

---

### Task 1: Update messageLoop implementation

**Files:**
- Modify: `src/core/messageLoop.ts`

**Interfaces:**
- Consumes: [docs/superpowers/specs/2026-07-22-horizontal-tier-fallback-design.md](docs/superpowers/specs/2026-07-22-horizontal-tier-fallback-design.md)
- Produces: Updated circular fallback chain building.

- [ ] **Step 1: Write the implementation changes**

  Update `src/core/messageLoop.ts` to replace the `CHANNELS` array and obsolete logic with the `ORDERED_MODELS` list, updated `buildChannelAwareChain`, and prefix-based `getChannelModel`.

  ```typescript
  export const ORDERED_MODELS = [
    // ── Tier 1: 极强推理 (Ultra Reasoning) ──
    'Claude Opus 4.6 (Thinking)',
    'DeepSeek: Pro Thinking',

    // ── Tier 2: 高级推理 (Advanced Reasoning) ──
    'Claude Sonnet 4.6 (Thinking)',
    'Web2API: Gemini 3.1 Pro Enhanced',
    'Gemini 3.1 Pro (High)',
    'Web2API: Gemini 3.1 Pro',
    'DeepSeek: Pro',
    'Gemini 3.1 Pro (Low)',

    // ── Tier 3: 通用智能 (General Capabilities) ──
    'Gemini 3.6 Flash (High)',
    'Web2API: Gemini 3.5 Flash Thinking',
    'DeepSeek: Flash Thinking Search',
    'Gemini 3.6 Flash (Medium)',
    'DeepSeek: Flash Thinking',
    'Web2API: Gemini 3.5 Flash Thinking Lite',
    'Gemini 3.6 Flash (Low)',
    'GPT-OSS 120B (Medium)',
    'Web2API: Gemini 3.5 Flash',

    // ── Tier 4: 快速轻量 (Speed & Light) ──
    'Gemini 3.5 Flash (High)',
    'DeepSeek: Flash Search',
    'Gemini 3.5 Flash (Medium)',
    'DeepSeek: Flash',
    'Web2API: Gemini Auto',
    'Gemini 3.5 Flash (Low)',
    'Web2API: Gemini Flash Lite'
  ];

  function buildChannelAwareChain(startModel: string): string[] {
    const idx = ORDERED_MODELS.indexOf(startModel);
    if (idx === -1) {
      return [startModel, ...ORDERED_MODELS];
    }
    const chain: string[] = [];
    for (let i = idx; i < ORDERED_MODELS.length; i++) {
      chain.push(ORDERED_MODELS[i]);
    }
    for (let i = 0; i < idx; i++) {
      chain.push(ORDERED_MODELS[i]);
    }
    return chain;
  }

  function getChannelModel(model: string): string | null {
    if (model.startsWith('Web2API:')) return 'web2api';
    if (model.startsWith('DeepSeek:')) return 'deepseek';
    return 'agy';
  }
  ```

  And change the fallback chain initialization at line 427:
  ```typescript
  const chain = buildChannelAwareChain(session.model || ORDERED_MODELS[0]);
  ```

- [ ] **Step 2: Run build to verify syntactic compilation**

  Run: `npm run build`
  Expected: Success without errors.

---

### Task 2: Refactor unit tests

**Files:**
- Modify: `src/core/messageLoop.test.ts`

**Interfaces:**
- Consumes: Updated circular fallback chain building.
- Produces: Green unit tests.

- [ ] **Step 1: Rewrite fallback tests**

  Update `src/core/messageLoop.test.ts` fallback tests:
  *   Test 2 (retry and downgrade): Set `mockSession.model = 'Gemini 3.1 Pro (Low)'` and verify the next fallback model is `Gemini 3.6 Flash (High)`.
  *   Test 3 (circular wrap-around): Set `mockSession.model = 'Web2API: Gemini Flash Lite'` and verify it walks all 25 models (`ORDERED_MODELS.length` * 3 = 75 attempts), wrapping around to `Claude Opus 4.6 (Thinking)` and ending at `Gemini 3.5 Flash (Low)`.

- [ ] **Step 2: Verify tests**

  Run: `npm run build && npm test`
  Expected: PASS.
